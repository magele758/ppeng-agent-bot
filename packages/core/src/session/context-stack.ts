/**
 * Read-only preview of the request the next model call would see.
 *
 * Uses the same fold, micro-compact, memory/working-log appendix, system
 * prompt, tool schemas, and budget fit as a turn. It does not compact, claim
 * inbox, persist a summary, or create a workspace.
 */

import { NotFoundError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import { applyJevToolSelect } from '../jev/apply.js';
import { estimateMessageTokens, estimateTokensFromText } from '../model/token-estimate.js';
import type { PromptBuilder } from '../model/prompt-builder.js';
import { resolveSessionModelAdapter } from '../model/provider-catalog.js';
import { hydrateTurnDynTools, queryForDynHydrate } from '../dyn-tools/hydrate.js';
import { isCanonicalBotChat } from './bot-compact-policy.js';
import {
  formatCompiledContextPack,
  lastUserQueryFromMessages,
  MEMORY_CONTEXT_APPENDIX_PREFIX,
  previewContextPackAsync
} from './context-compiler.js';
import {
  applyOptionalFoldBudget,
  prepareMessagesForModel,
  type PrepareViewHost
} from '../turn/prepare-view.js';
import { applyMemoryAppendixToMessages } from '../turn/prepare-turn-input.js';
import { filterToolsForSession, resolveTurnTools } from '../turn/resolve-turn-tools.js';
import type { AgentSpec, ModelAdapter, SessionMessage, SessionRecord, TaskRecord, ToolContract } from '../types.js';
import type { MessagePart, MessageRole } from '../types.js';
import { defaultWorkspaceRoots } from '../workspace/resolve.js';
import type { WorkspaceRootSpec } from '../workspace/types.js';
import { resolveEffectiveWorkspace } from '../workspace/effective.js';
import { workspaceBindingFromMetadata } from '../workspace/binding.js';
import { resolveBotWindowBudget } from './history/window.js';
import {
  NORMAL_SESSION_REQUEST_RATIO,
  estimateNormalRequestTokens,
  estimateToolSchemaTokens,
  fitNormalSessionRequest,
  pinnedRequestMessages,
  type CountedToolSchema
} from './normal-request-budget.js';
import { resolveMaxContextTokens } from './session-budget.js';
import { capSystemPromptForTaskFacts } from './task-context.js';
import { isToolResultStub } from './tool-result-stub.js';
import { readWorkingLogAppendix } from './working-log.js';

const IMAGE_PART_TOKEN_ESTIMATE = 1200;

export type ContextBlockKind =
  | 'system'
  | 'system-message'
  | 'tools'
  | 'summary'
  | 'memory'
  | 'working-log'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'tool-stub'
  | 'image'
  | 'surface'
  | 'history-sources';

export type ContextBlockDisposition = 'keep' | 'summarize' | 'dropped';

export interface ContextStackBlock {
  id: string;
  kind: ContextBlockKind;
  label: string;
  text: string;
  tokens: number;
  chars: number;
  pinned: boolean;
  disposition: ContextBlockDisposition;
  messageId?: string;
  seq?: number;
}

export interface ContextStackBudget {
  mode: 'normal' | 'canonical-bot';
  windowTokens: number;
  capTokens: number;
  requestTokens: number;
  pinnedTokens: number;
  pinnedOverBudget: boolean;
  wouldSummarize: boolean;
  wouldCompact: boolean;
  /** Ordinary chats: 0.2. Canonical bots: null (50/85 live on the other fields). */
  ratio: number | null;
  structuredTokens: number | null;
  hygieneTokens: number | null;
  historyTokens: number | null;
  messageTokens: number;
}

export interface ContextStackPayload {
  sessionId: string;
  blocks: ContextStackBlock[];
  budget: ContextStackBudget;
}

export interface ContextAppendixView {
  messageId: string;
  text: string;
  sections?: ReadonlyArray<{ id: string; title: string; text: string }>;
  workingLog?: boolean;
}

export interface ContextStackPreviewHost {
  store: SqliteStateStore;
  repoRoot: string;
  stateDir: string;
  tools: ToolContract<any>[];
  promptBuilder: PromptBuilder;
  modelAdapter: ModelAdapter;
  turnShapeBySession?: PrepareViewHost['turnShapeBySession'];
  env?: NodeJS.ProcessEnv;
  syncConnectorTools?(): void;
}

export interface DescribeContextBudgetInput {
  mode: 'normal' | 'canonical-bot';
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: SessionMessage[];
  maxContextTokens: number;
  botWindow?: {
    contextTokens: number;
    historyTokens: number;
    structuredTokens: number;
    hygieneTokens: number;
  };
}

export interface DescribedContextBudget {
  systemPrompt: string;
  budget: ContextStackBudget;
  dispositionById: Record<string, ContextBlockDisposition>;
  pinnedIds: string[];
}

function block(input: Omit<ContextStackBlock, 'chars'>): ContextStackBlock {
  return { ...input, chars: input.text.length };
}

function textKind(role: MessageRole): ContextBlockKind {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system-message';
    case 'tool':
      return 'tool-result';
    default: {
      const unreachable: never = role;
      return unreachable;
    }
  }
}

function isAppendixPart(text: string, appendix: string): boolean {
  return text === appendix || text === `${appendix}\n\n`;
}

function toolSchemaText(tools: readonly CountedToolSchema[]): string {
  const payload = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? {}
  }));
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return tools.map((tool) => tool.name).join('\n');
  }
}

function partBase(
  message: SessionMessage,
  index: number,
  disposition: ContextBlockDisposition,
  pinned: boolean
) {
  return {
    id: `${message.id}:${index}`,
    disposition,
    pinned,
    messageId: message.id,
    seq: message.seq
  };
}

function textBlock(
  message: SessionMessage,
  part: Extract<MessagePart, { type: 'text' }>,
  index: number,
  disposition: ContextBlockDisposition,
  pinned: boolean
): ContextStackBlock {
  return block({
    ...partBase(message, index, disposition, pinned),
    kind: textKind(message.role),
    label: message.role === 'system' ? message.key ?? '' : '',
    text: part.text,
    tokens: estimateTokensFromText(part.text)
  });
}

function imageLines(part: Extract<MessagePart, { type: 'image' }>): string[] {
  const lines = [`[image] ${part.mimeType}`, part.assetId];
  if (part.alt) lines.push(part.alt);
  if (part.sourceUrl) lines.push(part.sourceUrl);
  return lines;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function partBlock(
  message: SessionMessage,
  part: MessagePart,
  index: number,
  disposition: ContextBlockDisposition,
  pinned: boolean
): ContextStackBlock {
  const base = partBase(message, index, disposition, pinned);
  switch (part.type) {
    case 'text':
      return textBlock(message, part, index, disposition, pinned);
    case 'reasoning':
      return block({
        ...base,
        kind: 'reasoning',
        label: '',
        text: part.text,
        tokens: estimateTokensFromText(part.text)
      });
    case 'image':
      return block({
        ...base,
        kind: 'image',
        label: part.mimeType,
        text: imageLines(part).join('\n'),
        tokens: IMAGE_PART_TOKEN_ESTIMATE
      });
    case 'tool_call':
      return block({
        ...base,
        kind: 'tool-call',
        label: part.name,
        text: `${part.name}\n${prettyJson(part.input ?? {})}`,
        tokens: estimateTokensFromText(JSON.stringify(part.input ?? {}))
      });
    case 'tool_result':
      return block({
        ...base,
        kind: isToolResultStub(part.content) ? 'tool-stub' : 'tool-result',
        label: part.name,
        text: part.content,
        tokens: estimateTokensFromText(part.content)
      });
    case 'surface_update':
      return block({
        ...base,
        kind: 'surface',
        label: part.surfaceId,
        text: prettyJson({ surfaceId: part.surfaceId, catalogId: part.catalogId, messages: part.messages }),
        tokens: estimateTokensFromText(prettyJson({ surfaceId: part.surfaceId, catalogId: part.catalogId, messages: part.messages }))
      });
    default: {
      const unreachable: never = part;
      return unreachable;
    }
  }
}

function appendixBlocks(
  message: SessionMessage,
  appendix: ContextAppendixView | undefined,
  disposition: ContextBlockDisposition,
  pinned: boolean
): { blocks: ContextStackBlock[]; skipFirst: boolean } {
  if (!appendix?.text.trim() || appendix.messageId !== message.id) {
    return { blocks: [], skipFirst: false };
  }
  const first = message.parts[0];
  if (!first || first.type !== 'text' || !isAppendixPart(first.text, appendix.text)) {
    return { blocks: [], skipFirst: false };
  }
  const shared = { disposition, pinned, messageId: message.id, seq: message.seq };
  if (appendix.workingLog) {
    return {
      skipFirst: true,
      blocks: [
        block({
          ...shared,
          id: `appendix:${message.id}:log`,
          kind: 'working-log',
          label: 'working-log',
          text: appendix.text,
          tokens: estimateTokensFromText(appendix.text)
        })
      ]
    };
  }
  if (appendix.sections && appendix.sections.length > 0) {
    const blocks: ContextStackBlock[] = [
      block({
        ...shared,
        id: `appendix:${message.id}:prefix`,
        kind: 'memory',
        label: 'memory',
        text: MEMORY_CONTEXT_APPENDIX_PREFIX,
        tokens: estimateTokensFromText(MEMORY_CONTEXT_APPENDIX_PREFIX)
      })
    ];
    for (const section of appendix.sections) {
      if (!section.text.trim()) continue;
      const kind: ContextBlockKind = section.id === 'workingFile' ? 'working-log' : 'memory';
      blocks.push(
        block({
          ...shared,
          id: `appendix:${message.id}:${section.id}`,
          kind,
          label: section.title,
          text: section.text,
          tokens: estimateTokensFromText(section.text)
        })
      );
    }
    return { blocks, skipFirst: true };
  }
  return {
    skipFirst: true,
    blocks: [
      block({
        ...shared,
        id: `appendix:${message.id}:memory`,
        kind: 'memory',
        label: 'memory',
        text: appendix.text,
        tokens: estimateTokensFromText(appendix.text)
      })
    ]
  };
}

function messageBlocks(
  message: SessionMessage,
  disposition: ContextBlockDisposition,
  pinned: boolean,
  appendix: ContextAppendixView | undefined
): ContextStackBlock[] {
  if (message.key === 'compact-summary' || message.key === 'context-history-sources') {
    const text = message.parts
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return [
      block({
        id: `${message.id}:summary`,
        kind: message.key === 'compact-summary' ? 'summary' : 'history-sources',
        label: message.key,
        text,
        tokens: estimateTokensFromText(text),
        disposition,
        pinned,
        messageId: message.id,
        seq: message.seq
      })
    ];
  }
  const peeled = appendixBlocks(message, appendix, disposition, pinned);
  const parts = peeled.skipFirst ? message.parts.slice(1) : message.parts;
  const indexOffset = peeled.skipFirst ? 1 : 0;
  return [
    ...peeled.blocks,
    ...parts.map((part, index) => partBlock(message, part, index + indexOffset, disposition, pinned))
  ];
}

export function assembleContextStack(input: {
  sessionId: string;
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: readonly SessionMessage[];
  appendix?: ContextAppendixView;
  budget: ContextStackBudget;
  dispositionById?: Record<string, ContextBlockDisposition>;
  pinnedIds?: ReadonlySet<string>;
}): ContextStackPayload {
  const blocks: ContextStackBlock[] = [];
  if (input.systemPrompt) {
    blocks.push(
      block({
        id: 'system-prompt',
        kind: 'system',
        label: '',
        text: input.systemPrompt,
        tokens: estimateTokensFromText(input.systemPrompt),
        pinned: true,
        disposition: 'keep'
      })
    );
  }
  if (input.tools.length > 0) {
    blocks.push(
      block({
        id: 'tool-schemas',
        kind: 'tools',
        label: String(input.tools.length),
        text: toolSchemaText(input.tools),
        tokens: estimateToolSchemaTokens(input.tools),
        pinned: true,
        disposition: 'keep'
      })
    );
  }
  for (const message of input.messages) {
    const disposition = input.dispositionById?.[message.id] ?? 'keep';
    const pinned = input.pinnedIds?.has(message.id) ?? false;
    blocks.push(...messageBlocks(message, disposition, pinned, input.appendix));
  }
  return { sessionId: input.sessionId, blocks, budget: input.budget };
}

export function describeContextBudget(input: DescribeContextBudgetInput): DescribedContextBudget {
  const pinnedIds = pinnedRequestMessages(input.messages).map((message) => message.id);
  if (input.mode === 'canonical-bot') {
    const window = input.botWindow ?? {
      contextTokens: input.maxContextTokens,
      historyTokens: input.maxContextTokens,
      structuredTokens: Math.floor(input.maxContextTokens * 0.5),
      hygieneTokens: Math.floor(input.maxContextTokens * 0.85)
    };
    const messageTokens = estimateMessageTokens(input.messages);
    const dispositionById: Record<string, ContextBlockDisposition> = {};
    for (const message of input.messages) dispositionById[message.id] = 'keep';
    return {
      systemPrompt: input.systemPrompt,
      pinnedIds,
      dispositionById,
      budget: {
        mode: 'canonical-bot',
        windowTokens: window.contextTokens,
        capTokens: window.historyTokens,
        requestTokens: estimateNormalRequestTokens(input),
        pinnedTokens: estimateNormalRequestTokens({ ...input, messages: pinnedRequestMessages(input.messages) }),
        pinnedOverBudget: false,
        wouldSummarize: false,
        wouldCompact: messageTokens >= window.structuredTokens || messageTokens > window.historyTokens,
        ratio: null,
        structuredTokens: window.structuredTokens,
        hygieneTokens: window.hygieneTokens,
        historyTokens: window.historyTokens,
        messageTokens
      }
    };
  }

  const systemPrompt = capSystemPromptForTaskFacts({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    messages: input.messages,
    maxContextTokens: input.maxContextTokens
  });
  const fit = fitNormalSessionRequest({
    systemPrompt,
    tools: input.tools,
    messages: input.messages,
    maxContextTokens: input.maxContextTokens
  });
  const dispositionById: Record<string, ContextBlockDisposition> = {};
  if (!fit.summarizePrefix || !fit.summaryKept) {
    const keep = new Set(fit.messages);
    for (const message of input.messages) {
      dispositionById[message.id] = keep.has(message) ? 'keep' : 'dropped';
    }
  } else {
    const kept = new Set(fit.summaryKept);
    const summarize = new Set(fit.summarizePrefix);
    for (const message of input.messages) {
      if (kept.has(message)) dispositionById[message.id] = 'keep';
      else if (summarize.has(message)) dispositionById[message.id] = 'summarize';
      else dispositionById[message.id] = 'dropped';
    }
  }
  return {
    systemPrompt,
    pinnedIds,
    dispositionById,
    budget: {
      mode: 'normal',
      windowTokens: fit.windowTokens,
      capTokens: fit.capTokens,
      requestTokens: fit.requestTokens,
      pinnedTokens: fit.pinnedTokens,
      pinnedOverBudget: fit.pinnedOverBudget,
      wouldSummarize: Boolean(fit.summarizePrefix?.length),
      wouldCompact: false,
      ratio: NORMAL_SESSION_REQUEST_RATIO,
      structuredTokens: null,
      hygieneTokens: null,
      historyTokens: null,
      messageTokens: estimateMessageTokens(input.messages)
    }
  };
}

async function workspaceForPreview(
  host: ContextStackPreviewHost,
  session: SessionRecord,
  task: TaskRecord | undefined
): Promise<{ workspaceRoot?: string; workspaceRoots: WorkspaceRootSpec[] }> {
  const binding = workspaceBindingFromMetadata(session.metadata);
  if (binding.kind === 'project' || binding.kind === 'cloud_folder') {
    try {
      const effective = await resolveEffectiveWorkspace({
        store: host.store,
        session,
        repoRoot: host.repoRoot,
        stateDir: host.stateDir
      });
      return { workspaceRoot: effective.workspaceRoot, workspaceRoots: effective.workspaceRoots };
    } catch {
      return { workspaceRoots: defaultWorkspaceRoots(undefined, host.repoRoot) };
    }
  }
  const existing = task?.workspaceId ? host.store.getWorkspace?.(task.workspaceId)?.rootPath : undefined;
  return { workspaceRoot: existing, workspaceRoots: defaultWorkspaceRoots(existing, host.repoRoot) };
}

function lastUserMessageId(messages: readonly SessionMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return messages[i]!.id;
  }
  return undefined;
}

function countedTools(tools: readonly ToolContract<any>[]): CountedToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

export async function previewSessionContextStack(
  host: ContextStackPreviewHost,
  sessionId: string
): Promise<ContextStackPayload> {
  const env = host.env ?? process.env;
  const session = host.store.getSession(sessionId);
  if (!session) throw new NotFoundError('Session', sessionId);
  const agent = host.store.getAgent(session.agentId);
  if (!agent) throw new NotFoundError('Agent', session.agentId);
  const task = session.taskId ? host.store.getTask?.(session.taskId) : undefined;
  const workspace = await workspaceForPreview(host, session, task);
  const viewHost: PrepareViewHost = {
    store: host.store,
    emitTrace: () => {},
    turnShapeBySession: host.turnShapeBySession ?? new Map(),
    promptBuilder: host.promptBuilder
  };
  const folded = host.store.foldMessages(session.id);
  const budgeted = applyOptionalFoldBudget(viewHost, session, folded);
  const viewed = await prepareMessagesForModel(viewHost, session, budgeted);
  const query = lastUserQueryFromMessages(viewed);
  const pack = await previewContextPackAsync({
    session,
    query,
    store: host.store,
    stateDir: host.stateDir
  });
  const compiled = formatCompiledContextPack(pack);
  const appendixText = compiled.trim() ? compiled : readWorkingLogAppendix(host.stateDir, session.id, env);
  const prepared = applyMemoryAppendixToMessages(viewed, appendixText);
  const appendixMessageId = lastUserMessageId(viewed) ?? lastUserMessageId(prepared);
  const appendix: ContextAppendixView | undefined = appendixText.trim() && appendixMessageId
    ? {
        messageId: appendixMessageId,
        text: appendixText,
        ...(compiled.trim()
          ? { sections: pack.sections.map((section) => ({ id: section.id, title: section.title, text: section.text })) }
          : { workingLog: true })
      }
    : undefined;

  const systemPrompt = await host.promptBuilder.buildSystemPrompt(
    {
      agent,
      session,
      task,
      repoRoot: host.repoRoot,
      workspaceRoot: workspace.workspaceRoot,
      workspaceRoots: workspace.workspaceRoots
    },
    viewed
  );

  host.syncConnectorTools?.();
  const dynHydrated = hydrateTurnDynTools({
    store: host.store,
    session,
    query: queryForDynHydrate(prepared),
    materializeDeps: {
      getAuthorizedTools: (ctx) =>
        filterToolsForSession({
          env,
          tools: host.tools,
          agent: ctx.agent,
          session: ctx.session,
          settingsStore: host.store
        }).tools,
      previewAuthorizedTools: filterToolsForSession({
        env,
        tools: host.tools,
        agent,
        session,
        settingsStore: host.store
      }).tools,
      emitTrace: () => {}
    }
  });
  const selected = resolveTurnTools({
    env,
    tools: host.tools,
    agent,
    session,
    sessionId: session.id,
    systemPromptChars: systemPrompt.length,
    settingsStore: host.store,
    dynTools: dynHydrated.tools
  });
  const jevNames = await applyJevToolSelect(
    host.store,
    query,
    selected.turnTools.map((tool) => ({ name: tool.name, description: tool.description })),
    { preserveExposure: true }
  );
  const turnTools = jevNames
    ? selected.turnTools.filter((tool) => new Set(jevNames).has(tool.name))
    : selected.turnTools;
  const tools = countedTools(turnTools);
  const canonical = isCanonicalBotChat(session);
  const adapter = resolveSessionModelAdapter(host.store, session, env, host.modelAdapter);
  const botWindow = resolveBotWindowBudget(host.store, adapter, {
    systemPromptChars: systemPrompt.length,
    toolSchemaTokens: estimateToolSchemaTokens(tools)
  }, env);
  const described = canonical
    ? describeContextBudget({
        mode: 'canonical-bot',
        systemPrompt,
        tools,
        messages: prepared,
        maxContextTokens: botWindow.contextTokens,
        botWindow
      })
    : describeContextBudget({
        mode: 'normal',
        systemPrompt,
        tools,
        messages: prepared,
        maxContextTokens: resolveMaxContextTokens(env)
      });

  return assembleContextStack({
    sessionId: session.id,
    systemPrompt: described.systemPrompt,
    tools,
    messages: prepared,
    appendix,
    budget: described.budget,
    dispositionById: described.dispositionById,
    pinnedIds: new Set(described.pinnedIds)
  });
}

import { createRoomRouteTool } from '../rooms/route-tool.js';
import { createHistoryTools } from './history-tools.js';
import type { HistoryStore } from '../session/history-retrieval.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  persistCloudFolderAfterWrite,
  primaryWorkspacePath,
  resolveWorkspacePath,
  sandboxWorkspaceRoots
} from '../workspace/index.js';
import { resolvePermissionMode } from '../approval/permission-mode.js';
import { commandHardlineToolResult } from '../sandbox/command-hardline.js';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import { redactToolContent } from '../sandbox/result-redaction.js';
import { createAgentSandboxFromEnv } from '../sandbox/create-agent-sandbox.js';
import type { AgentSandbox } from '../sandbox/agent-sandbox-types.js';
import type { SandboxMode } from '../sandbox/sandbox-settings.js';
import {
  DIRECT_ISOLATION_REFUSAL,
  decideShellIsolation,
  formatOsSandboxNote,
  isolationInputSchema,
  shellCallNeedsDirectApproval,
  shellIsolationAvailability,
  type OsSandboxReason
} from '../sandbox/model-isolation.js';
import { createExternalAiTools } from './external-ai-tools.js';
import { bashCommandNeedsApproval } from './bash-command-policy.js';
import { globWorkspaceFiles } from './glob-files.js';
import { isVaultMetadataDirName } from './markdown-vault-noise.js';
import { SENSITIVE_READ_REFUSAL, sensitiveReadRefusal } from '../workspace/sensitive-read.js';
import {
  OTHER_BOT_FILE_REFUSAL,
  SIBLING_FILE_REFUSAL,
  decideForkSiblingFileRead,
  filterGrepContent,
  type ForkSiblingFileFacts
} from '../bots/fork-sibling-isolation.js';
import { runWorkspaceGrep } from './grep-workspace.js';
import { readFileLineRange, shouldStreamReadFile } from './read-file-range.js';
import { lspSendRequest, parseLspConfigFromEnv } from './lsp-client.js';
import { fetchUrlText, webFetchAllowsPrivate, webSearchFromEnv } from './web-fetch.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { egressNeedsApproval } from '../safety/egress.js';
import { resolveWebSearchTemplate, WEB_SEARCH_NOT_CONFIGURED, type WebSettingsReadStore } from './web-settings.js';
import {
  HARNESS_ARTIFACT_DIR,
  HARNESS_ARTIFACT_FILES,
  type AgentSpec,
  type BackgroundJobRecord,
  type HarnessWriteSpecKind,
  type MailRecord,
  type RunContext,
  type SessionMessage,
  type TaskRecord,
  type TodoItem,
  type ToolContract,
  type ToolExecutionResult
} from '../types.js';
import { retrieveStoredToolResult, resolveToolResultLookup } from '../session/tool-result-retrieve.js';
import { createArtifactTools } from './artifact-tools.js';
import { createCompactContextTool } from './compact-context-tool.js';
import { loadGatewayChannelIdsSync } from '../gateway-config-channels.js';
import type { BotMemoryLookup } from '../memory/bot-memory-scope.js';
import { createMemoryTools, type ExtendedMemoryToolServices } from './memory-tools.js';
import { createPlanTools } from './plan-tools.js';
import { createInteractionTools } from './interaction-tools.js';
import {
  SOCIAL_POST_SCHEDULE_METADATA_KEY,
  SOCIAL_POST_TASK_KIND,
  buildSocialPostSchedule,
  taskTitleForSocialSchedule,
  type SocialPostApprovalState
} from '../social-schedule.js';
import {
  A2UI_PROTOCOL_VERSION,
  AGENT_NATIVE_CATALOG_ID,
  BASIC_CATALOG_ID,
  surfaceIdOf,
  validateA2uiStream,
  type A2uiMessage
} from '../a2ui/index.js';

export interface RuntimeToolServices {
  currentUserText?(sessionId: string): Promise<string>;
  loadSkill: (name: string, sessionId: string) => Promise<{ content?: string; error?: string }>;
  searchSkills: (
    query: string,
    sessionId: string,
    limit?: number
  ) => Promise<{ content: string }>;
  updateTodo: (sessionId: string, items: TodoItem[]) => Promise<TodoItem[]>;
  createTask: (input: {
    title: string;
    description?: string;
    blockedBy?: string[];
    ownerAgentId?: string;
    sessionId?: string;
    parentTaskId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<TaskRecord>;
  getTask: (taskId: string) => Promise<TaskRecord | undefined>;
  listTasks: () => Promise<TaskRecord[]>;
  updateTask: (
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'ownerAgentId' | 'blockedBy' | 'workspaceId' | 'metadata'>>
  ) => Promise<TaskRecord>;
  harnessWriteSpec: (
    context: RunContext,
    input: { kind: HarnessWriteSpecKind; content: string }
  ) => Promise<string>;
  spawnSubagent: (
    context: RunContext,
    prompt: string,
    role?: string,
    opts?: {
      allowedTools?: string[];
      model?: string;
      minConfidence?: number;
      summaryMaxChars?: number;
      signal?: AbortSignal;
      scratchKeyFilter?: (key: string) => boolean;
    }
  ) => Promise<string>;
  /** Structured form; `ok: false` when the child is parked on approval or failed. */
  spawnSubagentOutcome?: (
    context: RunContext,
    prompt: string,
    role?: string,
    opts?: {
      allowedTools?: string[];
      model?: string;
      minConfidence?: number;
      summaryMaxChars?: number;
      signal?: AbortSignal;
      scratchKeyFilter?: (key: string) => boolean;
    }
  ) => Promise<{ ok: boolean; content: string }>;
  spawnTeammate: (context: RunContext, input: { name: string; role: string; prompt: string }) => Promise<string>;
  spawnTeammateOutcome?: (
    context: RunContext,
    input: { name: string; role: string; prompt: string }
  ) => Promise<{ ok: boolean; content: string }>;
  listAgents: () => Promise<AgentSpec[]>;
  sendMail: (
    context: RunContext,
    input: { toAgentId: string; content: string; type?: string; correlationId?: string }
  ) => Promise<MailRecord>;
  readInbox: (agentId: string) => Promise<MailRecord[]>;
  startBackgroundJob: (
    sessionId: string,
    command: string,
    options?: { isolation?: unknown }
  ) => Promise<BackgroundJobRecord>;
  /** True only when a person has approved this exact direct-isolation call. Missing hook fails closed. */
  directIsolationApproved?: (sessionId: string, toolName: string, args: Record<string, unknown>) => boolean;
  getBackgroundJob: (jobId: string) => Promise<BackgroundJobRecord | undefined>;
  listBackgroundJobs: (sessionId?: string) => Promise<BackgroundJobRecord[]>;
  listWorkspaces: () => Promise<Array<{ id: string; taskId: string; name: string; rootPath: string; mode: string }>>;
  upsertSessionMemory: (
    sessionId: string,
    scope: 'scratch' | 'long',
    key: string,
    value: string,
    metadata?: Record<string, unknown>
  ) => Promise<void>;
  listSessionMemory: (sessionId: string, scope?: 'scratch' | 'long') => Promise<unknown[]>;
  deleteSessionMemory: (sessionId: string, scope: 'scratch' | 'long', key: string) => Promise<boolean>;
  upsertAgentMemory?: (input: {
    scope: import('../memory/types.js').MemoryScope;
    namespace: string;
    key: string;
    value: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    agentId?: string;
  }) => Promise<void>;
  listAgentMemory?: (input: {
    scope: import('../memory/types.js').MemoryScope;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    tenantOrGlobal?: boolean;
    agentId?: string;
    agentUnscoped?: boolean;
    query?: string;
    limit?: number;
  }) => Promise<unknown[]>;
  prefetchAgentMemory?: (input: {
    sessionId: string;
    userId?: string;
    tenantId?: string;
    query?: string;
    limit?: number;
    agentId?: string;
  }) => Promise<unknown[]>;
  getAgentMemoryById?: (id: string) => Promise<import('../memory/types.js').AgentMemory | null>;
  botLookup?: BotMemoryLookup;
  visionAnalyze: (input: {
    sessionId: string;
    assetIds: string[];
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  historyStore?: HistoryStore;
  /** Current-session transcript only. Used by retrieve_tool_result. */
  listSessionMessages?: (sessionId: string) => SessionMessage[];
  compactContext?: (context: RunContext, opts?: { force?: boolean }) => Promise<string>;
  /** Lab KV for web_search URL; env is CI fallback. */
  webSearchSettingsStore?: WebSettingsReadStore;
  /** Sibling-file facts for a sub-task read. Missing hook keeps the previous read behavior. */
  forkSiblingFileFacts?: (context: RunContext) => ForkSiblingFileFacts;
  /** Record a file this sub-task just created so siblings cannot read it. */
  noteForkSiblingWrite?: (context: RunContext, absolutePath: string) => void;
}

// Lazy singleton — native | remote_vm | microservice via RAW_AGENT_AGENT_SANDBOX_KIND
let _agentSandbox: AgentSandbox | undefined;
function getAgentSandbox(): AgentSandbox {
  if (!_agentSandbox) _agentSandbox = createAgentSandboxFromEnv();
  return _agentSandbox;
}

function clipEvidenceText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… truncated (${text.length - maxChars} more chars)`;
}

function workEvidenceDiffCap(): number {
  const rawEnv = process.env.RAW_AGENT_WORK_EVIDENCE_DIFF_MAX_CHARS?.trim();
  const parsed = rawEnv ? Number(rawEnv) : NaN;
  const fallback = 120_000;
  const n = Number.isFinite(parsed) && parsed >= 4096 ? Math.floor(parsed) : fallback;
  return Math.min(n, 2_000_000);
}

function withOsSandboxNote(result: ToolExecutionResult, reason: OsSandboxReason | undefined): ToolExecutionResult {
  if (!reason) return result;
  return {
    ...result,
    content: `${result.content}\n${formatOsSandboxNote(reason)}`,
    metadata: { ...result.metadata, os_sandbox_reason: reason }
  };
}

function shellExecution(
  command: string,
  cwd: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    sessionId?: string;
    workspace?: string | string[];
    isolation?: SandboxMode;
    osSandboxReason?: OsSandboxReason;
  }
): Promise<ToolExecutionResult> {
  const sandbox = getAgentSandbox();
  return sandbox
    .execute({
      command,
      cwd,
      workspace: options?.workspace ?? cwd,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      sessionId: options?.sessionId,
      allowNetwork: true,
      ...(options?.isolation ? { isolation: options.isolation } : {})
    })
    .then((result) => {
    if (options?.signal?.aborted) {
      return withOsSandboxNote(
        {ok:false, content:'(command aborted)', metadata:{exitCode:result.code, signal:result.signal, ...(result.backend ? { sandbox_backend: result.backend } : {})}},
        options.osSandboxReason
      );
    }
    const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const raw = combined || `(command exited with ${result.code ?? result.signal ?? 'unknown'} and no output)`;
    // P0 return-path redaction: injected/host secret values must not flow back to the model.
    const ok = result.code === 0 && result.signal === null;
    return withOsSandboxNote(
      {ok, content:redactToolContent(ok ? raw : `${raw}\n[exit_code=${result.code ?? 'unknown'}; signal=${result.signal ?? 'none'}]`, process.env), metadata:{exitCode:result.code, signal:result.signal, ...(result.backend ? { sandbox_backend: result.backend } : {})}},
      options?.osSandboxReason
    );
  });
}

function repoPath(context: RunContext, path: string): string {
  return resolveWorkspacePath(context, path);
}

/** Directories named credentials stay readable. A file with that exact name does not. */
async function readableStat(
  target: string
): Promise<{ ok: true; stat: Awaited<ReturnType<typeof stat>> } | { ok: false; content: string }> {
  if (sensitiveReadRefusal(target, undefined, 'directory')) {
    return { ok: false, content: SENSITIVE_READ_REFUSAL };
  }
  const targetStat = await stat(target);
  if (targetStat.isDirectory() || !sensitiveReadRefusal(target)) return { ok: true, stat: targetStat };
  return { ok: false, content: SENSITIVE_READ_REFUSAL };
}

function externalAiToolsEnabled(): boolean {
  const v = process.env.RAW_AGENT_EXTERNAL_AI_TOOLS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function notebookToolsEnabled(): boolean {
  const v = process.env.RAW_AGENT_NOTEBOOK_TOOLS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function a2uiToolsEnabled(): boolean {
  const v = process.env.RAW_AGENT_A2UI_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function parseTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error('items must be an array');
  }

  let inProgress = 0;
  const parsed = raw.map((item, index) => {
    const record = item as Record<string, unknown>;
    const content = String(record.content ?? '').trim();
    const status = String(record.status ?? 'pending') as TodoItem['status'];
    const activeForm = String(record.activeForm ?? '').trim();

    if (!content) {
      throw new Error(`todo item ${index} is missing content`);
    }
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      throw new Error(`todo item ${index} has invalid status ${status}`);
    }
    if (!activeForm) {
      throw new Error(`todo item ${index} is missing activeForm`);
    }
    if (status === 'in_progress') {
      inProgress += 1;
    }

    return {
      content,
      status,
      activeForm
    };
  });

  if (inProgress > 1) {
    throw new Error('only one todo may be in_progress');
  }

  return parsed;
}

export function createBuiltinTools(services: RuntimeToolServices): ToolContract<any>[] {
  const riskyShellTokens = ['rm ', 'git reset', 'git checkout', 'git clean', 'npm publish', 'sudo '];

  function gateShell(context: RunContext, toolName: string, args: { isolation?: unknown }) {
    const decision = decideShellIsolation(args.isolation, shellIsolationAvailability(getAgentSandbox().kind));
    if (!decision.ok) return { ok: false as const, content: decision.message };
    if (
      decision.explicitDirect &&
      resolvePermissionMode(context.session.metadata, process.env) !== 'bypass' &&
      services.directIsolationApproved?.(context.session.id, toolName, args as Record<string, unknown>) !== true
    ) {
      return { ok: false as const, content: DIRECT_ISOLATION_REFUSAL };
    }
    return {
      ok: true as const,
      mode: decision.localMode === 'inherit' ? undefined : decision.localMode,
      osSandboxReason: decision.osSandboxReason
    };
  }

  function forkFacts(context: RunContext): ForkSiblingFileFacts | undefined {
    return services.forkSiblingFileFacts?.(context);
  }

  function forkRefusal(facts: ForkSiblingFileFacts | undefined, absolutePath: string): string | undefined {
    if (!facts) return undefined;
    const decision = decideForkSiblingFileRead(facts, absolutePath);
    if (decision.allow) return undefined;
    switch (decision.kind) {
      case 'sibling-private':
        return SIBLING_FILE_REFUSAL;
      case 'other-bot-private':
        return OTHER_BOT_FILE_REFUSAL;
      default: {
        const unreachable: never = decision;
        return unreachable;
      }
    }
  }

  async function visibleDirectoryLines(directory: string, facts: ForkSiblingFileFacts | undefined): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const lines: string[] = [];
    for (const entry of entries) {
      if (isVaultMetadataDirName(entry.name)) continue;
      if (forkRefusal(facts, join(directory, entry.name))) continue;
      lines.push(`${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`);
    }
    return lines;
  }

  const readFileTool: ToolContract<{ path?: string; limit?: number; offset_line?: number }> = {
    name: 'read_file',
    description:
      'Read a file or list the current workspace directory. For large files use offset_line + limit to read a line window without loading the whole file. Directory listings omit Obsidian-style metadata folders (.obsidian, .trash).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
        offset_line: { type: 'number', description: '0-based start line when reading a file' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const facts = forkFacts(context);
      if (!args.path) {
        const roots = context.workspaceRoots?.length
          ? context.workspaceRoots
          : [{ alias: 'repo', path: primaryWorkspacePath(context), primary: true }];
        const blocks: string[] = [];
        for (const root of roots) {
          if (sensitiveReadRefusal(root.path, undefined, 'directory')) {
            return { ok: false, content: SENSITIVE_READ_REFUSAL };
          }
          const blocked = forkRefusal(facts, root.path);
          if (blocked) return { ok: false, content: blocked };
          const lines = await visibleDirectoryLines(root.path, facts);
          blocks.push(`@${root.alias}${root.primary ? ' (primary)' : ''}: ${root.path}\n${lines.join('\n') || '(empty)'}`);
        }
        return {
          ok: true,
          content: blocks.join('\n\n')
        };
      }

      const target = repoPath(context, args.path);
      const readable = await readableStat(target);
      if (!readable.ok) return { ok: false, content: SENSITIVE_READ_REFUSAL };
      const targetStat = readable.stat;
      const blocked = forkRefusal(facts, target);
      if (blocked) return { ok: false, content: blocked };
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
      const offsetLine = typeof args.offset_line === 'number' && args.offset_line >= 0 ? args.offset_line : 0;

      if (targetStat.isDirectory()) {
        const lines = await visibleDirectoryLines(target, facts);
        const sliced =
          limit && lines.length > limit ? [...lines.slice(0, limit), `... (${lines.length - limit} more entries)`] : lines;
        return {
          ok: true,
          content: sliced.join('\n') || '(empty directory)'
        };
      }

      const useWindow = offsetLine > 0 || (limit !== undefined && (await shouldStreamReadFile(target)));
      if (useWindow && limit !== undefined) {
        const { lines, truncated } = await readFileLineRange(target, offsetLine, limit);
        const header = `lines ${offsetLine}-${offsetLine + lines.length - 1}${truncated ? ' (more below)' : ''}\n`;
        return {
          ok: true,
          content: header + lines.join('\n')
        };
      }

      const content = await readFile(target, 'utf8');
      const lines = content.split('\n');
      const sliceStart = offsetLine;
      const sliceEnd = limit !== undefined ? sliceStart + limit : lines.length;
      const windowed = lines.slice(sliceStart, sliceEnd);
      const moreBelow = sliceEnd < lines.length;
      const header =
        offsetLine > 0 || moreBelow
          ? `lines ${sliceStart}-${sliceStart + windowed.length - 1}${moreBelow ? ` of ${lines.length}` : ''}\n`
          : '';
      return {
        ok: true,
        content: header + windowed.join('\n') + (moreBelow ? `\n... (${lines.length - sliceEnd} more lines)` : '')
      };
    }
  };

  const grepFilesTool: ToolContract<{
    pattern: string;
    glob?: string;
    max_matches?: number;
    context_lines?: number;
  }> = {
    name: 'grep_files',
    description: 'Search file contents under the workspace with ripgrep or grep.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string' },
        max_matches: { type: 'number' },
        context_lines: { type: 'number' }
      },
      required: ['pattern']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const facts = forkFacts(context);
      const roots = sandboxWorkspaceRoots(context);
      const max = typeof args.max_matches === 'number' && args.max_matches > 0 ? args.max_matches : 50;
      const ctx = typeof args.context_lines === 'number' && args.context_lines >= 0 ? args.context_lines : 0;
      const visible = (content: string, cwd: string) => (facts ? filterGrepContent(content, facts, cwd) : content);
      if (roots.length <= 1) {
        const cwd = roots[0] ?? primaryWorkspacePath(context);
        const blocked = forkRefusal(facts, cwd);
        if (blocked) return { ok: false, content: blocked };
        const result = await runWorkspaceGrep({
          cwd,
          pattern: args.pattern,
          glob: args.glob,
          maxMatches: max,
          contextLines: ctx
        });
        return { ok: result.ok, content: visible(result.content, cwd) };
      }
      const chunks: string[] = [];
      let ok = true;
      for (const root of roots) {
        const blocked = forkRefusal(facts, root);
        if (blocked) {
          ok = false;
          chunks.push(`[${root}]\n${blocked}`);
          continue;
        }
        const result = await runWorkspaceGrep({
          cwd: root,
          pattern: args.pattern,
          glob: args.glob,
          maxMatches: max,
          contextLines: ctx
        });
        if (!result.ok) ok = false;
        chunks.push(`[${root}]\n${visible(result.content, root)}`);
      }
      return { ok, content: chunks.join('\n\n') };
    }
  };

  const globFilesTool: ToolContract<{ pattern: string; max_results?: number }> = {
    name: 'glob_files',
    description:
      'List file paths under the workspace matching a glob pattern (Node built-in glob). Skips `.git`, `node_modules`, `.obsidian`, `.trash` path segments (Obsidian vault / deps noise). Use instead of bash find for simple discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to workspace root, e.g. **/*.ts' },
        max_results: { type: 'number' }
      },
      required: ['pattern']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const roots = sandboxWorkspaceRoots(context);
      if (roots.length <= 1) {
        return globWorkspaceFiles({
          cwd: roots[0] ?? primaryWorkspacePath(context),
          pattern: args.pattern,
          maxResults: args.max_results
        });
      }
      const chunks: string[] = [];
      let ok = true;
      for (const root of roots) {
        const result = await globWorkspaceFiles({
          cwd: root,
          pattern: args.pattern,
          maxResults: args.max_results
        });
        if (!result.ok) ok = false;
        chunks.push(`[${root}]\n${result.content}`);
      }
      return { ok, content: chunks.join('\n\n') };
    }
  };

  const webFetchTool: ToolContract<{ url: string }> = {
    name: 'web_fetch',
    description:
      'HTTP GET a public URL and return text (size-capped; blocks private IPs unless RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE=1). Honors Content-Type charset and HTML <meta charset> when the header omits it. Heavy JS/canvas UIs may still need a user screenshot + vision_analyze for reliable visual grounding.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    ptc: { kind: 'read' },
    needsApproval: () => false,
    async execute(_context, args) {
      const maxBytes = Number(process.env.RAW_AGENT_WEB_FETCH_MAX_BYTES);
      const r = await fetchUrlText({
        url: args.url,
        maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined,
        allowPrivateHosts: webFetchAllowsPrivate()
      });
      if (!r.ok) return { ok: false, content: r.content };
      return {
        ok: true,
        content: fenceExternalContent({ source: 'web_fetch', label: args.url, body: r.content })
      };
    }
  };

  const webSearchTool: ToolContract<{ query: string }> = {
    name: 'web_search',
    description:
      'Search the public web via the Lab-configured URL template (must contain {query}). Not offered when unconfigured.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    ptc: { kind: 'read' },
    needsApproval: () => false,
    async execute(_context, args) {
      const template = resolveWebSearchTemplate(services.webSearchSettingsStore, process.env);
      if (!template) {
        return { ok: false, content: WEB_SEARCH_NOT_CONFIGURED };
      }
      const r = await webSearchFromEnv(process.env, { query: args.query, templateUrl: template });
      if (!r.ok) return { ok: false, content: r.content };
      return {
        ok: true,
        content: fenceExternalContent({ source: 'web_fetch', label: args.query, body: r.content })
      };
    }
  };

  const visionAnalyzeTool: ToolContract<{ asset_ids: string[]; prompt: string }> = {
    name: 'vision_analyze',
    description:
      'Run the configured VL model on one or more session image assets (ids from user messages / image parts). Use for OCR, UI description, diagram reading.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Image asset ids belonging to the current session'
        },
        prompt: { type: 'string', description: 'What to extract or answer about the image(s)' }
      },
      required: ['asset_ids', 'prompt']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const text = await services.visionAnalyze({
        sessionId: context.session.id,
        assetIds: args.asset_ids,
        prompt: args.prompt,
        signal: context.abortSignal
      });
      return { ok: true, content: text };
    }
  };

  const spillToolResultTool: ToolContract<{ content: string; label?: string }> = {
    name: 'spill_tool_result',
    description:
      'Write large text under .agent-spills/<sessionId>/ in the workspace (or repo) so read_file can paginate with offset_line/limit.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        label: { type: 'string' }
      },
      required: ['content']
    },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    async execute(context, args) {
      const root = primaryWorkspacePath(context);
      const relDir = join('.agent-spills', context.session.id);
      const dir = join(root, relDir);
      await mkdir(dir, { recursive: true });
      const name = `${args.label ?? 'spill'}-${Date.now()}.txt`;
      const relPath = join(relDir, name).replace(/\\/g, '/');
      await writeFile(join(dir, name), args.content, 'utf8');
      return {
        ok: true,
        content: `Spilled ${args.content.length} bytes. Use read_file with path "${relPath}" and offset_line/limit for chunks.`
      };
    }
  };

  const retrieveToolResultTool: ToolContract<{
    message_id?: string;
    part?: number;
    seq?: number;
    stub?: string;
  }> = {
    name: 'retrieve_tool_result',
    description:
      'Read the stored (full) tool_result for THIS session by the address on a micro-compact stub (msg= / part= / seq=). Use when a previous tool output was dropped from context. Read-only; cannot access other sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Session message id from the stub (msg=…)' },
        part: { type: 'number', description: 'tool_result part index (default 0)' },
        seq: { type: 'number', description: 'Optional WAL seq from the stub' },
        stub: { type: 'string', description: 'Paste the whole [previous: used …] stub line' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      if (!services.listSessionMessages) {
        return { ok: false, content: 'Stored transcript is not available in this host.' };
      }
      const lookup = resolveToolResultLookup({
        messageId: typeof args.message_id === 'string' ? args.message_id.trim() : undefined,
        partIndex: typeof args.part === 'number' && Number.isFinite(args.part) ? args.part : undefined,
        seq: typeof args.seq === 'number' && Number.isFinite(args.seq) ? args.seq : undefined,
        stub: typeof args.stub === 'string' ? args.stub : undefined
      });
      if (!lookup.messageId && lookup.seq === undefined && !lookup.stub) {
        return { ok: false, content: 'Provide message_id, seq, or stub from the dropped-output placeholder.' };
      }
      const found = retrieveStoredToolResult(services.listSessionMessages(context.session.id), lookup);
      if (!found) {
        return { ok: false, content: 'No stored tool_result for that address in this session.' };
      }
      return { ok: true, content: found.content };
    }
  };

  const memoryTools = createMemoryTools(services as ExtendedMemoryToolServices);

  const writeFileTool: ToolContract<{ path: string; content: string }> = {
    name: 'write_file',
    description: 'Write a file relative to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(context, args) {
      const target = repoPath(context, args.path);
      let created = false;
      try {
        await stat(target);
      } catch {
        created = true;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, args.content, 'utf8');
      if (created) services.noteForkSiblingWrite?.(context, target);
      await persistCloudFolderAfterWrite(context, target);
      return {
        ok: true,
        content: `Wrote ${args.content.length} bytes to ${args.path}`
      };
    }
  };

  const editFileTool: ToolContract<{ path: string; oldText: string; newText: string }> = {
    name: 'edit_file',
    description: 'Replace the first occurrence of oldText in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' }
      },
      required: ['path', 'oldText', 'newText']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(context, args) {
      const target = repoPath(context, args.path);
      const original = await readFile(target, 'utf8');
      if (!original.includes(args.oldText)) {
        return {
          ok: false,
          content: `Text not found in ${args.path}`
        };
      }

      await writeFile(target, original.replace(args.oldText, args.newText), 'utf8');
      await persistCloudFolderAfterWrite(context, target);
      return {
        ok: true,
        content: `Edited ${args.path}`
      };
    }
  };

  const bashTool: ToolContract<{ command: string; timeout_ms?: number; isolation?: string }> = {
    name: 'bash',
    description:
      'Run a shell command inside the workspace root. Optional timeout_ms (default from env RAW_AGENT_BASH_TIMEOUT_MS). Optional isolation is honored when the saved mode is Auto; omit it to follow the saved mode. Auto uses the strongest available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
        isolation: isolationInputSchema()
      },
      required: ['command']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval(_context, args) {
      return (
        shellCallNeedsDirectApproval(args.isolation, shellIsolationAvailability(getAgentSandbox().kind)) ||
        bashCommandNeedsApproval(args.command)
      );
    },
    async execute(context, args) {
      const denied = commandHardlineToolResult(String(args.command ?? ''));
      if (denied) return denied;
      const gated = gateShell(context, 'bash', args);
      if (!gated.ok) return { ok: false, content: gated.content };
      const envDefault = Number(process.env.RAW_AGENT_BASH_TIMEOUT_MS);
      const timeoutMs =
        typeof args.timeout_ms === 'number' && args.timeout_ms > 0
          ? args.timeout_ms
          : Number.isFinite(envDefault) && envDefault > 0
            ? envDefault
            : 120_000;
      return shellExecution(args.command, primaryWorkspacePath(context), {
          timeoutMs,
          signal: context.abortSignal,
          sessionId: context.session.id,
          workspace: sandboxWorkspaceRoots(context),
          isolation: gated.mode,
          osSandboxReason: gated.osSandboxReason
        });
    }
  };

  const workEvidenceTool: ToolContract<{
    verify_command?: string;
    verify_timeout_ms?: number;
    include_diff_stat?: boolean;
    isolation?: string;
  }> = {
    name: 'work_evidence',
    description:
      'Collect verifiable evidence of local changes before claiming completion: git branch/revision, porcelain status line count, unstaged/staged diff stats (read-only git), and optionally run a verification command with its exit code surfaced explicitly (use for npm test/build, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        verify_command: {
          type: 'string',
          description: 'Optional shell command to run in the workspace root (e.g. pnpm run test); stdout/stderr and exit_code are included in the payload.'
        },
        verify_timeout_ms: { type: 'number' },
        include_diff_stat: {
          type: 'boolean',
          description: 'When false, skip unstaged/staged git diff --stat sections (still collects status porcelain). Default true.'
        },
        isolation: isolationInputSchema()
      }
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval(_context, args) {
      if (shellCallNeedsDirectApproval(args.isolation, shellIsolationAvailability(getAgentSandbox().kind))) return true;
      const cmd = String(args.verify_command ?? '').trim();
      if (!cmd) return false;
      return riskyShellTokens.some((token) => cmd.includes(token));
    },
    async execute(context, args) {
      const gated = gateShell(context, 'work_evidence', args);
      if (!gated.ok) return { ok: false, content: gated.content };
      const cwd = primaryWorkspacePath(context);
      const sandbox = getAgentSandbox();
      const sessionId = context.session.id;
      const signal = context.abortSignal;
      const diffClip = workEvidenceDiffCap();
      const includeDiff = args.include_diff_stat !== false;
      const workspace = sandboxWorkspaceRoots(context);

      const execEvidence = async (command: string, timeoutMs: number) =>
        sandbox.execute({
          command,
          cwd,
          workspace,
          timeoutMs,
          signal,
          sessionId,
          allowNetwork: true,
          ...(gated.mode ? { isolation: gated.mode } : {})
        });

      const inside = await execEvidence('git rev-parse --is-inside-work-tree', 15_000);
      const gitAvailable = inside.code === 0 && inside.stdout.trim() === 'true';

      const evidence: Record<string, unknown> = {
        cwd,
        workspace_root: cwd,
        git_is_repo: gitAvailable
      };

      if (!gitAvailable) {
        evidence.git_error =
          inside.code !== 0
            ? clipEvidenceText(`${inside.stdout}\n${inside.stderr}`.trim(), 4096)
            : 'not a git repository';
      } else {
        const branchR = await execEvidence('git rev-parse --abbrev-ref HEAD', 15_000);
        const shortR = await execEvidence('git rev-parse --short HEAD', 15_000);
        const porcelainR = await execEvidence('git status --porcelain=v1', 120_000);
        evidence.git_branch =
          branchR.code === 0 ? branchR.stdout.trim() : `error(code=${branchR.code})`;
        evidence.git_head_short =
          shortR.code === 0 ? shortR.stdout.trim() : `error(code=${shortR.code})`;
        evidence.git_status_porcelain_lines =
          porcelainR.code === 0 ? porcelainR.stdout.split('\n').filter(Boolean).length : null;
        evidence.git_status_porcelain_clip = clipEvidenceText(
          porcelainR.code === 0 ? porcelainR.stdout.trim() : `(git status failed, code=${porcelainR.code})\n${porcelainR.stderr}`,
          diffClip
        );

        if (includeDiff) {
          const unstaged = await execEvidence('git diff --stat', 120_000);
          const staged = await execEvidence('git diff --cached --stat', 120_000);
          evidence.git_unstaged_diff_stat_clip = clipEvidenceText(
            unstaged.code === 0 ? unstaged.stdout.trim() : `(failed, code=${unstaged.code})\n${unstaged.stderr}`,
            diffClip
          );
          evidence.git_staged_diff_stat_clip = clipEvidenceText(
            staged.code === 0 ? staged.stdout.trim() : `(failed, code=${staged.code})\n${staged.stderr}`,
            diffClip
          );
        }
      }

      const verifyCmd = String(args.verify_command ?? '').trim();
      if (verifyCmd) {
        const envDefault = Number(process.env.RAW_AGENT_BASH_TIMEOUT_MS);
        const timeoutMs =
          typeof args.verify_timeout_ms === 'number' && args.verify_timeout_ms > 0
            ? args.verify_timeout_ms
            : Number.isFinite(envDefault) && envDefault > 0
              ? envDefault
              : 120_000;
        const vr = await execEvidence(verifyCmd, timeoutMs);
        evidence.verify = {
          command: verifyCmd,
          exit_code: vr.code,
          signal: vr.signal,
          stdout_clip: clipEvidenceText(vr.stdout.trim(), diffClip),
          stderr_clip: clipEvidenceText(vr.stderr.trim(), diffClip),
          sandbox_backend: vr.backend
        };
      }

      if (gated.osSandboxReason) evidence.os_sandbox_note = formatOsSandboxNote(gated.osSandboxReason);
      const payload = `${JSON.stringify(evidence, null, 2)}\n`;
      const vc =
        typeof evidence.verify === 'object' && evidence.verify !== null
          ? (evidence.verify as Record<string, unknown>).exit_code
          : undefined;
      const verifyFailed =
        typeof evidence.verify === 'object' &&
        evidence.verify !== null &&
        (typeof vc !== 'number' || vc !== 0);
      return { ok: !verifyFailed, content: payload };
    }
  };

  const todoWriteTool: ToolContract<{ items: TodoItem[] }> = {
    name: 'TodoWrite',
    description: 'Update the session todo list.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: {
          type: 'object', properties: {
            content: {type:'string',minLength:1},
            status: {type:'string',enum:['pending','in_progress','completed']},
            activeForm: {type:'string',minLength:1,description:'Present-tense activity label; required for every item.'}
          }, required:['content','status','activeForm'], additionalProperties:false
        }, description:'At most one item may be in_progress.' }
      },
      required: ['items']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const items = parseTodoItems(args.items);
      const updated = await services.updateTodo(context.session.id, items);
      const lines = updated.map((item) => {
        const marker = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]';
        const suffix = item.status === 'in_progress' ? ` <- ${item.activeForm}` : '';
        return `${marker} ${item.content}${suffix}`;
      });
      return {
        ok: true,
        content: lines.join('\n')
      };
    }
  };

  const searchSkillsTool: ToolContract<{ query: string; limit?: number }> = {
    name: 'search_skills',
    description:
      'Search the skill catalog by a short query (name, description, body). Returns ranked names to pass to load_skill. Use this when the prompt does not list skills (lazy disclosure) or when you need a skill not in the shortlist.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max hits (1–20, default 8)' }
      },
      required: ['query']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const { content } = await services.searchSkills(args.query, context.session.id, args.limit);
      return {
        ok: true,
        content
      };
    }
  };

  const loadSkillTool: ToolContract<{ name: string }> = {
    name: 'load_skill',
    description:
      'Load a skill by name (repo `skills/` and `~/.agents/**/SKILL.md`; same name in ~/.agents overrides). If the catalog is not listed, call search_skills first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const { content, error } = await services.loadSkill(args.name, context.session.id);
      return {
        ok: Boolean(content),
        content: content ?? error ?? `Unknown skill ${args.name}`
      };
    }
  };

  const taskCreateTool: ToolContract<{
    title: string;
    description?: string;
    blockedBy?: string[];
    ownerAgentId?: string;
  }> = {
    name: 'task_create',
    description: 'Create a persistent task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        blockedBy: { type: 'array', items: { type: 'string' } },
        ownerAgentId: { type: 'string' }
      },
      required: ['title']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const task = await services.createTask({
        title: args.title,
        description: args.description,
        blockedBy: args.blockedBy,
        ownerAgentId: args.ownerAgentId,
        sessionId: context.session.id,
        parentTaskId: context.task?.id
      });
      return {
        ok: true,
        content: JSON.stringify(task, null, 2)
      };
    }
  };

  const taskGetTool: ToolContract<{ taskId: string }> = {
    name: 'task_get',
    description: 'Fetch one task by id.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }
      },
      required: ['taskId']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(_context, args) {
      const task = await services.getTask(args.taskId);
      return {
        ok: Boolean(task),
        content: task ? JSON.stringify(task, null, 2) : `Task ${args.taskId} not found`
      };
    }
  };

  const taskUpdateTool: ToolContract<{
    taskId: string;
    status?: TaskRecord['status'];
    ownerAgentId?: string;
    blockedBy?: string[];
    metadata?: Record<string, unknown>;
  }> = {
    name: 'task_update',
    description:
      'Update task status, owner, dependencies, or metadata (metadata merges with existing keys). Use metadata.harnessSprint* for sprint contract workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
        ownerAgentId: { type: 'string' },
        blockedBy: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', description: 'Shallow-merged into existing task metadata' }
      },
      required: ['taskId']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_context, args) {
      const task = await services.updateTask(args.taskId, {
        status: args.status,
        ownerAgentId: args.ownerAgentId,
        blockedBy: args.blockedBy,
        metadata: args.metadata
      });
      return {
        ok: true,
        content: JSON.stringify(task, null, 2)
      };
    }
  };

  const taskListTool: ToolContract<Record<string, never>> = {
    name: 'task_list',
    description: 'List all tasks.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute() {
      const tasks = await services.listTasks();
      return {
        ok: true,
        content: tasks.length > 0 ? JSON.stringify(tasks, null, 2) : 'No tasks.'
      };
    }
  };

  const scheduleSocialPostTool: ToolContract<{
    body: string;
    channels: string[];
    publish_at: string;
    approval?: SocialPostApprovalState;
    first_comment?: string;
    follow_up_hint?: string;
    idempotency_key?: string;
  }> = {
    name: 'schedule_social_post',
    description:
      'Queue a multi-channel social post as a task with structured metadata (approval + publish time + optional first comment). Channels must be built-in labels (x, linkedin, …) or webhook:<id> where <id> exists in gateway.config.json channels. Operators use GET/POST /api/social-post-schedules and the Ops panel. idempotency_key prevents duplicate publishes after a successful dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Post body / main text' },
        channels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Targets e.g. x, linkedin, webhook:<gateway channel id>'
        },
        publish_at: { type: 'string', description: 'ISO 8601 UTC time to publish' },
        approval: {
          type: 'string',
          enum: ['draft', 'pending_approval', 'approved', 'rejected'],
          description: 'Defaults to pending_approval'
        },
        first_comment: { type: 'string', description: 'Optional first comment (e.g. X reply)' },
        follow_up_hint: { type: 'string', description: 'Optional note for future auto-reply' },
        idempotency_key: { type: 'string', description: 'Omit to auto-generate' }
      },
      required: ['body', 'channels', 'publish_at']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'none',
    needsApproval: (_context, args) => egressNeedsApproval('schedule_social_post', args),
    async execute(context, args) {
      const gatewayChannelIds = loadGatewayChannelIdsSync(context.repoRoot);
      const built = buildSocialPostSchedule({
        body: args.body,
        channels: args.channels,
        publishAt: args.publish_at,
        approval: 'pending_approval',
        firstComment: args.first_comment,
        followUpHint: args.follow_up_hint,
        idempotencyKey: args.idempotency_key,
        gatewayChannelIds
      });
      if (!built.ok) {
        return { ok: false, content: built.error };
      }
      const schedule = built.schedule;
      const task = await services.createTask({
        title: taskTitleForSocialSchedule(schedule.body),
        description: schedule.body,
        ownerAgentId: context.agent.id,
        sessionId: context.session.id,
        parentTaskId: context.task?.id,
        metadata: {
          kind: SOCIAL_POST_TASK_KIND,
          [SOCIAL_POST_SCHEDULE_METADATA_KEY]: schedule
        }
      });
      return {
        ok: true,
        content: JSON.stringify(
          {
            taskId: task.id,
            schedule,
            note: 'Use POST /api/social-post-schedules/:taskId/action (approve | reject | cancel | run_now); list via GET /api/social-post-schedules.'
          },
          null,
          2
        )
      };
    }
  };

  const spawnSubagentTool: ToolContract<{
    prompt: string;
    role?: string;
    allowed_tools?: string[];
    model?: string;
    min_confidence?: number;
  }> = {
    name: 'spawn_subagent',
    description:
      'Run a clean-context subagent and return its summary only. role maps to builtin agents: research→researcher, implement→implementer, review→reviewer, planner→planner, generator→generator, evaluator→evaluator; otherwise uses the parent agent. Optional allowed_tools / min_confidence for review gates.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        role: {
          type: 'string',
          description:
            'Optional: research | implement | review | planner | generator | evaluator (harness roles) or omit to inherit parent agent'
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tool name allowlist for the child session'
        },
        model: { type: 'string', description: 'Optional model override hint for the child' },
        min_confidence: {
          type: 'number',
          description: 'For review/evaluator: require confidence: N line; flag if below threshold (default 80)'
        }
      },
      required: ['prompt']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const spawnArgs = {
        allowedTools: args.allowed_tools,
        model: args.model,
        minConfidence: args.min_confidence
      };
      if (services.spawnSubagentOutcome) {
        return services.spawnSubagentOutcome(context, args.prompt, args.role, spawnArgs);
      }
      return {
        ok: true,
        content: await services.spawnSubagent(context, args.prompt, args.role, spawnArgs)
      };
    }
  };

  const spawnTeammateTool: ToolContract<{ name: string; role: string; prompt: string }> = {
    name: 'spawn_teammate',
    description:
      'Create a persistent teammate session that can continue in the background. If the result has blocked=true the teammate is waiting for human approval (ids and remediation included); do not spawn a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        prompt: { type: 'string' }
      },
      required: ['name', 'role', 'prompt']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const input = { name: args.name, role: args.role, prompt: args.prompt };
      if (services.spawnTeammateOutcome) {
        return services.spawnTeammateOutcome(context, input);
      }
      return { ok: true, content: await services.spawnTeammate(context, input) };
    }
  };

  const listTeamTool: ToolContract<Record<string, never>> = {
    name: 'list_team',
    description: 'List registered agents and teammates.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute() {
      const agents = await services.listAgents();
      return {
        ok: true,
        content: JSON.stringify(agents, null, 2)
      };
    }
  };

  const sendMessageTool: ToolContract<{
    toAgentId: string;
    content: string;
    type?: string;
    correlationId?: string;
  }> = {
    name: 'send_message',
    description: 'Send a mailbox message to another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string' },
        correlationId: { type: 'string' }
      },
      required: ['toAgentId', 'content']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const mail = await services.sendMail(context, args);
      return {
        ok: true,
        content: JSON.stringify(mail, null, 2)
      };
    }
  };

  const readInboxTool: ToolContract<Record<string, never>> = {
    name: 'read_inbox',
    description: 'Read pending mailbox messages for the current agent.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context) {
      const mail = await services.readInbox(context.agent.id);
      return {
        ok: true,
        content: mail.length > 0 ? JSON.stringify(mail, null, 2) : 'Inbox empty.'
      };
    }
  };

  const bgRunTool: ToolContract<{ command: string; isolation?: string }> = {
    name: 'bg_run',
    description:
      'Run a long command in the background. Optional isolation is honored when the saved mode is Auto; omit it to follow the saved mode. Auto uses the strongest available.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        isolation: isolationInputSchema()
      },
      required: ['command']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval(_context, args) {
      return shellCallNeedsDirectApproval(args.isolation, shellIsolationAvailability(getAgentSandbox().kind));
    },
    async execute(context, args) {
      const denied = commandHardlineToolResult(String(args.command ?? ''));
      if (denied) return denied;
      const gated = gateShell(context, 'bg_run', args);
      if (!gated.ok) return { ok: false, content: gated.content };
      const job = await services.startBackgroundJob(context.session.id, args.command, { isolation: args.isolation });
      const payload = gated.osSandboxReason
        ? { ...job, os_sandbox_note: formatOsSandboxNote(gated.osSandboxReason) }
        : job;
      return {
        ok: true,
        content: JSON.stringify(payload, null, 2)
      };
    }
  };

  const bgCheckTool: ToolContract<{ jobId?: string }> = {
    name: 'bg_check',
    description: 'Check one background job or list all of them.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      if (args.jobId) {
        const job = await services.getBackgroundJob(args.jobId);
        return {
          ok: Boolean(job),
          content: job ? JSON.stringify(job, null, 2) : `Background job ${args.jobId} not found`
        };
      }

      const jobs = await services.listBackgroundJobs(context.session.id);
      return {
        ok: true,
        content: jobs.length > 0 ? JSON.stringify(jobs, null, 2) : 'No background jobs.'
      };
    }
  };

  const workspaceListTool: ToolContract<Record<string, never>> = {
    name: 'workspace_list',
    description: 'List active task workspaces.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute() {
      const workspaces = await services.listWorkspaces();
      return {
        ok: true,
        content: workspaces.length > 0 ? JSON.stringify(workspaces, null, 2) : 'No workspaces.'
      };
    }
  };

  const harnessWriteSpecTool: ToolContract<{
    kind: HarnessWriteSpecKind;
    content: string;
  }> = {
    name: 'harness_write_spec',
    description: `Write a structured harness artifact under ${HARNESS_ARTIFACT_DIR}/ (${HARNESS_ARTIFACT_FILES.productSpec}, ${HARNESS_ARTIFACT_FILES.requirementsBacklog}, ${HARNESS_ARTIFACT_FILES.sprintContract}, ${HARNESS_ARTIFACT_FILES.evaluatorFeedback}) for handoffs across compaction or subagents.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['product_spec', 'requirements_backlog', 'sprint_contract', 'evaluator_feedback'],
          description:
            'Which artifact to write: product_spec (high-level outcomes), requirements_backlog (numbered testable requirements incl. NFR/UX), sprint_contract (one sprint scope + acceptance), evaluator_feedback (QA findings)'
        },
        content: { type: 'string', description: 'Full markdown body' }
      },
      required: ['kind', 'content']
    },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    async execute(context, args) {
      const path = await services.harnessWriteSpec(context, {
        kind: args.kind,
        content: args.content
      });
      return {
        ok: true,
        content: `Wrote ${path}`
      };
    }
  };

  const recordSummaryTool: ToolContract<{ message: string }> = {
    name: 'record_summary',
    description: 'Create a summary artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' }
      },
      required: ['message']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_context, args) {
      return {
        ok: true,
        content: args.message,
        artifacts: [
          {
            kind: 'summary',
            label: 'summary',
            value: args.message
          }
        ]
      };
    }
  };

  const lspRequestTool: ToolContract<{ method: string; params?: Record<string, unknown> }> = {
    name: 'lsp_request',
    description:
      'Send a single LSP request after initialize (requires RAW_AGENT_LSP_ENABLED=1 and RAW_AGENT_LSP_COMMAND JSON with command/args).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { type: 'object' }
      },
      required: ['method']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval: () => true,
    async execute(_context, args) {
      const cfg = parseLspConfigFromEnv(process.env);
      if (!cfg) {
        return {
          ok: false,
          content: 'LSP disabled. Set RAW_AGENT_LSP_ENABLED=1 and RAW_AGENT_LSP_COMMAND={"command":"...","args":[]}.'
        };
      }
      try {
        const text = await lspSendRequest(cfg, args.method, args.params ?? {});
        return { ok: true, content: text };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { ok: false, content: msg };
      }
    }
  };

  const notebookEditTool: ToolContract<{ path: string; cell_index: number; source: string }> = {
    name: 'notebook_edit',
    description:
      'Edit one code/markdown cell in a Jupyter .ipynb file (nbformat). Requires RAW_AGENT_NOTEBOOK_TOOLS=1.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Notebook path relative to workspace' },
        cell_index: { type: 'number', description: '0-based cell index' },
        source: { type: 'string', description: 'New cell source text' }
      },
      required: ['path', 'cell_index', 'source']
    },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    async execute(context, args) {
      const target = repoPath(context, args.path);
      if (!target.toLowerCase().endsWith('.ipynb')) {
        return { ok: false, content: 'Path must end with .ipynb' };
      }
      const raw = await readFile(target, 'utf8');
      const nb = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> };
      const cells = nb.cells;
      if (!cells || args.cell_index < 0 || args.cell_index >= cells.length) {
        return { ok: false, content: 'Invalid cell_index for this notebook' };
      }
      const cell = cells[args.cell_index];
      if (!cell) {
        return { ok: false, content: 'Missing cell' };
      }
      if (cell.cell_type !== 'code' && cell.cell_type !== 'markdown') {
        return { ok: false, content: `Cell ${args.cell_index} is not code or markdown` };
      }
      const lines = args.source.split('\n');
      cell.source = lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
      await writeFile(target, `${JSON.stringify(nb, null, 2)}\n`, 'utf8');
      await persistCloudFolderAfterWrite(context, target);
      return { ok: true, content: `Updated cell ${args.cell_index} in ${args.path}` };
    }
  };

  const a2uiRenderTool: ToolContract<{
    surfaceId: string;
    catalogId?: string;
    messages: A2uiMessage[];
  }> = {
    name: 'a2ui_render',
    description:
      'Render or update an Agent-to-UI (A2UI v0.9) surface in the chat. Pass a sequence of envelope messages (createSurface / updateComponents / updateDataModel / deleteSurface). Use catalogId "https://ppeng.dev/agent-core/a2ui/v1" for project-native components (TaskCard, ApprovalRequest, …) or the basic catalog for generic UI. The surface is persisted with the assistant turn so it re-renders on session reload. Load the "a2ui" skill for the catalog cheat-sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: 'Stable id for this surface (reuse to update an existing surface)' },
        catalogId: {
          type: 'string',
          description: `Defaults to ${AGENT_NATIVE_CATALOG_ID}. Use ${BASIC_CATALOG_ID} for generic basic-catalog components.`
        },
        messages: {
          type: 'array',
          description: 'A2UI v0.9 envelope sequence. First call to a new surfaceId must include a createSurface message.'
        }
      },
      required: ['surfaceId', 'messages']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_context, args) {
      const surfaceId = String(args.surfaceId ?? '').trim();
      if (!surfaceId) return { ok: false, content: 'surfaceId is required' };
      const incoming = Array.isArray(args.messages) ? args.messages : [];
      if (incoming.length === 0) {
        return { ok: false, content: 'messages must be a non-empty array of A2UI envelopes' };
      }

      const fallbackCatalogId =
        typeof args.catalogId === 'string' && args.catalogId.trim()
          ? args.catalogId.trim()
          : AGENT_NATIVE_CATALOG_ID;

      // Auto-stamp version + surfaceId so agents can omit obvious boilerplate.
      const messages: A2uiMessage[] = incoming.map((raw, idx) => {
        const source =
          raw && typeof raw === 'object' ? (raw as unknown as Record<string, unknown>) : {};
        const m: Record<string, unknown> = { ...source };
        if (m.version === undefined) m.version = A2UI_PROTOCOL_VERSION;
        if (m.createSurface && typeof m.createSurface === 'object') {
          const cs = m.createSurface as Record<string, unknown>;
          if (!cs.surfaceId) cs.surfaceId = surfaceId;
          if (!cs.catalogId) cs.catalogId = fallbackCatalogId;
        }
        if (m.updateComponents && typeof m.updateComponents === 'object') {
          const uc = m.updateComponents as Record<string, unknown>;
          if (!uc.surfaceId) uc.surfaceId = surfaceId;
        }
        if (m.updateDataModel && typeof m.updateDataModel === 'object') {
          const ud = m.updateDataModel as Record<string, unknown>;
          if (!ud.surfaceId) ud.surfaceId = surfaceId;
        }
        if (m.deleteSurface && typeof m.deleteSurface === 'object') {
          const ds = m.deleteSurface as Record<string, unknown>;
          if (!ds.surfaceId) ds.surfaceId = surfaceId;
        }
        const candidate = m as unknown as A2uiMessage;
        const sid = surfaceIdOf(candidate);
        if (sid && sid !== surfaceId) {
          throw new Error(`messages[${idx}] surfaceId ${sid} does not match tool arg ${surfaceId}`);
        }
        return candidate;
      });

      let result;
      try {
        result = validateA2uiStream(messages);
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }

      // A batch that includes createSurface stamps the actual catalogId on the
      // SurfaceUpdatePart; otherwise we leave it empty (the renderer derives
      // the live catalogId from the cross-message accumulator anyway). The
      // caller-supplied `args.catalogId` is only used as the createSurface
      // default, not as a per-part claim.
      const surface = result.surfaces.get(surfaceId);
      const batchHasCreate = messages.some(
        (m) => m && typeof m === 'object' && 'createSurface' in (m as unknown as Record<string, unknown>)
      );
      const catalogId = batchHasCreate ? (surface?.catalogId || fallbackCatalogId) : '';
      const summary =
        `Surface ${surfaceId} updated with ${messages.length} message(s).` +
        (result.warnings.length ? `\nWarnings:\n - ${result.warnings.join('\n - ')}` : '');
      return {
        ok: true,
        content: summary,
        metadata: {
          a2uiMessages: messages,
          a2uiSurfaceId: surfaceId,
          a2uiCatalogId: catalogId
        }
      };
    }
  };

  const a2uiDeleteSurfaceTool: ToolContract<{ surfaceId: string }> = {
    name: 'a2ui_delete_surface',
    description: 'Dismiss a previously rendered A2UI surface by id.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string' }
      },
      required: ['surfaceId']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(_context, args) {
      const surfaceId = String(args.surfaceId ?? '').trim();
      if (!surfaceId) return { ok: false, content: 'surfaceId is required' };
      const messages: A2uiMessage[] = [
        { version: A2UI_PROTOCOL_VERSION, deleteSurface: { surfaceId } }
      ];
      return {
        ok: true,
        content: `Surface ${surfaceId} dismissed.`,
        metadata: {
          a2uiMessages: messages,
          a2uiSurfaceId: surfaceId,
          // Catalog id is unknown post-delete; renderer doesn't need it for delete.
          a2uiCatalogId: ''
        }
      };
    }
  };

  const tools: ToolContract<any>[] = [
    bashTool,
    workEvidenceTool,
    readFileTool,
    visionAnalyzeTool,
    grepFilesTool,
    globFilesTool,
    webFetchTool,
    webSearchTool,
    spillToolResultTool,
    retrieveToolResultTool,
    ...memoryTools,
    ...createHistoryTools(services),
    ...createPlanTools(),
    ...createInteractionTools(),
    createRoomRouteTool(),
    writeFileTool,
    editFileTool,
    todoWriteTool,
    searchSkillsTool,
    loadSkillTool,
    taskCreateTool,
    taskGetTool,
    taskUpdateTool,
    taskListTool,
    scheduleSocialPostTool,
    harnessWriteSpecTool,
    spawnSubagentTool,
    spawnTeammateTool,
    listTeamTool,
    sendMessageTool,
    readInboxTool,
    bgRunTool,
    bgCheckTool,
    workspaceListTool,
    recordSummaryTool,
    lspRequestTool,
    ...createArtifactTools()
  ];

  if (services.compactContext) {
    tools.push(createCompactContextTool({ compactContext: services.compactContext }));
  }

  if (notebookToolsEnabled()) {
    tools.push(notebookEditTool);
  }

  if (a2uiToolsEnabled()) {
    tools.push(a2uiRenderTool, a2uiDeleteSurfaceTool);
  }

  if (externalAiToolsEnabled()) {
    tools.push(...createExternalAiTools());
  }

  return tools;
}

export { createExternalAiTools };

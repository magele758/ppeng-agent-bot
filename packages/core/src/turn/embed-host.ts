/**
 * Thin L3 host for embedders: custom SessionSurfaceStore + ModelAdapter + tools.
 * No RawAgentRuntime, no daemon listen, no AUTH_TOKEN, no evolving/goal wiring.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionRegistry } from '../extensions/extension-registry.js';
import { normalizeAuthorizedBy } from '../approval/authorized-by.js';
import { createId, nowIso } from '../id.js';
import type { PromptContext } from '../model/prompt-builder.js';
import type { ToolLoopDeps, ToolLoopStore } from '../runtime/tool-loop.js';
import type { SessionSurfaceStore } from '../session/surface-store.js';
import {
  applyOptionalFoldBudget,
  prepareMessagesForModel,
  type PrepareViewHost
} from './prepare-view.js';
import {
  checkToolApprovals,
  executeToolCalls,
  filterValidToolCalls,
  processToolResults,
  runTurnWithRetries
} from './tool-dispatch.js';
import type {
  RunTurnKernelInput,
  ToolCallPart,
  TurnKernelHost,
  TurnKernelPrompt,
  TurnKernelStore
} from './host.js';
import type {
  AgentSpec,
  ApprovalRecord,
  SessionRecord,
  ToolContract
} from '../types.js';

export const DEFAULT_EMBED_AGENT: AgentSpec = {
  id: 'general',
  name: 'General',
  role: 'assistant',
  instructions: 'You are a helpful assistant.',
  capabilities: []
};

type SurfaceWithExtras = SessionSurfaceStore & Partial<TurnKernelStore>;

function defaultTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createEmbedTurnPrompt(options?: { systemPrompt?: string }): TurnKernelPrompt {
  const lastCognitivePhaseBySession = new Map<string, { phase: string; confidence: number }>();
  const fallback = (ctx: PromptContext): string => {
    if (options?.systemPrompt?.trim()) return options.systemPrompt.trim();
    return [`You are ${ctx.agent.name} (${ctx.agent.role}).`, ctx.agent.instructions]
      .filter(Boolean)
      .join('\n\n');
  };
  return {
    lastCognitivePhaseBySession,
    getRouting() {
      return undefined;
    },
    buildMemoryAppendix() {
      return '';
    },
    buildStablePrefix(ctx) {
      return fallback(ctx);
    },
    async buildSystemPrompt(ctx) {
      return fallback(ctx);
    }
  };
}

export function adaptTurnKernelStore(
  surface: SessionSurfaceStore,
  options?: { agent?: AgentSpec; agents?: AgentSpec[] }
): TurnKernelStore {
  const extra = surface as SurfaceWithExtras;
  const agents = new Map<string, AgentSpec>();
  for (const spec of options?.agents ?? []) {
    agents.set(spec.id, spec);
  }
  if (options?.agent) {
    agents.set(options.agent.id, options.agent);
  }
  if (!agents.has(DEFAULT_EMBED_AGENT.id)) {
    agents.set(DEFAULT_EMBED_AGENT.id, DEFAULT_EMBED_AGENT);
  }

  const sessionOverlay = new Map<string, SessionRecord>();

  const store: TurnKernelStore = {
    getSession(id) {
      const overlay = sessionOverlay.get(id);
      if (overlay) {
        return { ...overlay, metadata: { ...overlay.metadata } };
      }
      return extra.getSession(id);
    },
    appendMessage: (sessionId, role, parts, opts) => extra.appendMessage(sessionId, role, parts, opts),
    appendReplacement: (sessionId, input) => extra.appendReplacement(sessionId, input),
    hideByKey: (sessionId, key, opts) => extra.hideByKey(sessionId, key, opts),
    hideRange: (sessionId, startSeq, endSeq, opts) => extra.hideRange(sessionId, startSeq, endSeq, opts),
    foldMessages: (sessionId) => extra.foldMessages(sessionId),
    listMessages: (sessionId) => extra.listMessages(sessionId),
    listSurfaceNodes: (sessionId) => extra.listSurfaceNodes(sessionId),
    enqueueSteer: (sessionId, text, opts) => extra.enqueueSteer(sessionId, text, opts),
    claimInbox: (sessionId, target) => extra.claimInbox(sessionId, target),
    getAgent(id) {
      if (typeof extra.getAgent === 'function') {
        return extra.getAgent(id) ?? agents.get(id);
      }
      return agents.get(id) ?? { ...DEFAULT_EMBED_AGENT, id };
    },
    getTask(id) {
      return extra.getTask?.(id);
    },
    updateSession(id, patch) {
      if (typeof extra.updateSession === 'function') {
        return extra.updateSession(id, patch);
      }
      const current = store.getSession(id);
      if (!current) {
        throw new Error(`Session ${id} not found`);
      }
      const next: SessionRecord = {
        ...current,
        ...patch,
        metadata: { ...current.metadata, ...(patch.metadata ?? {}) },
        updatedAt: nowIso()
      };
      sessionOverlay.set(id, next);
      return next;
    },
    getImageAsset(id) {
      return extra.getImageAsset?.(id);
    },
    claimWriter(sessionId, runId) {
      extra.claimWriter?.(sessionId, runId);
    },
    releaseWriter(sessionId, runId) {
      extra.releaseWriter?.(sessionId, runId);
    },
    listApprovals(filter) {
      if (typeof extra.listApprovals === 'function') {
        return extra.listApprovals(filter);
      }
      return [];
    },
    getDaemonControl(key) {
      return extra.getDaemonControl?.(key);
    }
  };

  return store;
}

function embedPendingApproval(
  list: ApprovalRecord[],
  input: { sessionId: string; idempotencyKey?: string }
): ApprovalRecord | undefined {
  if (!input.idempotencyKey) return undefined;
  return list.find(
    (row) => row.status === 'pending' && row.sessionId === input.sessionId && row.idempotencyKey === input.idempotencyKey
  );
}

function fillEmbedAuthorizedBy(pending: ApprovalRecord, authorizedBy: string[] | undefined): ApprovalRecord {
  if (authorizedBy && !pending.authorizedBy?.length) pending.authorizedBy = authorizedBy;
  return pending;
}

function createEmbedApprovalBag(): {
  list: ApprovalRecord[];
  listApprovals: TurnKernelStore['listApprovals'];
  createApproval: ToolLoopStore['createApproval'];
  deleteApproval: ToolLoopStore['deleteApproval'];
} {
  const list: ApprovalRecord[] = [];
  return {
    list,
    listApprovals(filter) {
      const filtered = filter?.status ? list.filter((a) => a.status === filter.status) : list;
      return [...filtered];
    },
    createApproval(input) {
      const authorizedBy = normalizeAuthorizedBy(input.authorizedBy);
      const pending = embedPendingApproval(list, input);
      if (pending) return fillEmbedAuthorizedBy(pending, authorizedBy);
      const rec: ApprovalRecord = {
        id: createId('appr'),
        sessionId: input.sessionId,
        toolName: input.toolName,
        status: 'pending',
        reason: input.reason,
        args: input.args,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(authorizedBy ? { authorizedBy } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      list.push(rec);
      return rec;
    },
    deleteApproval(id) {
      const i = list.findIndex((a) => a.id === id);
      if (i >= 0) list.splice(i, 1);
    }
  };
}

export function createEmbedTurnHost(
  input: Omit<RunTurnKernelInput, 'sessionId' | 'latch'>
): TurnKernelHost {
  const store = adaptTurnKernelStore(input.store, {
    agent: input.agent,
    agents: input.agents
  });
  const tools: ToolContract<any>[] = input.tools ?? [];
  const promptBuilder = createEmbedTurnPrompt({ systemPrompt: input.systemPrompt });
  const repoRoot = input.repoRoot ?? defaultTempDir('ppeng-l3-repo-');
  const stateDir = input.stateDir ?? defaultTempDir('ppeng-l3-state-');
  const turnShapeBySession = new Map<string, { systemPromptChars: number; toolCount: number }>();
  const bag = createEmbedApprovalBag();
  const originalListApprovals = store.listApprovals.bind(store);
  const useBagApprovals = typeof (input.store as SurfaceWithExtras).listApprovals !== 'function';
  if (useBagApprovals) {
    store.listApprovals = bag.listApprovals;
  }

  const toolLoopStore: ToolLoopStore = {
    appendMessage: (sessionId, role, parts) => store.appendMessage(sessionId, role, parts),
    listApprovals: useBagApprovals ? bag.listApprovals : originalListApprovals,
    createApproval: bag.createApproval,
    deleteApproval: bag.deleteApproval,
    getTask: (id) => store.getTask(id),
    updateTask: () => undefined
  };

  const toolLoopDeps: ToolLoopDeps = {
    tools,
    store: toolLoopStore,
    envApprovalPolicy: undefined,
    maxParallelToolCalls: 8,
    modelAdapter: input.model,
    stateDir,
    emitTrace: () => undefined
  };

  const viewHost: PrepareViewHost = {
    store,
    emitTrace: () => undefined,
    turnShapeBySession,
    promptBuilder
  };

  return {
    store,
    repoRoot,
    stateDir,
    tools,
    modelAdapter: input.model,
    promptBuilder,
    mcpManager: { ensureLoaded: async () => undefined },
    extensionRegistry: new ExtensionRegistry(),
    maxTurnsPerRun: input.maxTurns ?? 32,
    turnShapeBySession,
    cumulativeInputTokensBySession: new Map(),
    sessionAbortControllers: new Map(),
    emitTrace() {
      /* embed: no daemon trace sink */
    },
    mergeSessionMetadata(sessionId, patch) {
      const current = store.getSession(sessionId);
      if (!current) {
        throw new Error(`Session ${sessionId} not found`);
      }
      return store.updateSession(sessionId, {
        metadata: { ...current.metadata, ...patch }
      });
    },
    async ensureWorkspaceRoot() {
      return undefined;
    },
    async ingestMailbox() {
      /* embed: no mailbox */
    },
    async autoClaimTask() {
      /* embed: no task scheduler */
    },
    async mergedFilePolicy() {
      return undefined;
    },
    async autoCompact() {
      return {};
    },
    prepareMessagesForModel(session, messages) {
      return prepareMessagesForModel(viewHost, session, messages);
    },
    applyOptionalFoldBudget(session, folded) {
      return applyOptionalFoldBudget(viewHost, session, folded);
    },
    async resolveImageDataUrl() {
      return undefined;
    },
    runTurnWithRetries(turnInput, onStream) {
      return runTurnWithRetries(input.model, turnInput, onStream);
    },
    filterValidToolCalls(toolCalls: ToolCallPart[], allowExternalAiTools, sessionId, turnTools) {
      return filterValidToolCalls(toolLoopDeps, toolCalls, allowExternalAiTools, sessionId, turnTools);
    },
    checkToolApprovals(validToolCalls, context, filePolicy, session, turnTools, closure) {
      return checkToolApprovals(toolLoopDeps, validToolCalls, context, filePolicy, session, turnTools, closure);
    },
    executeToolCalls(validToolCalls, context, allowExternalAiTools, sessionId, turnTools) {
      return executeToolCalls(
        toolLoopDeps,
        validToolCalls,
        context,
        allowExternalAiTools,
        sessionId,
        turnTools
      );
    },
    processToolResults(results, validToolCalls, session, task, sessionId, onModelStreamChunk) {
      processToolResults(
        toolLoopDeps,
        results,
        validToolCalls,
        session,
        task,
        sessionId,
        onModelStreamChunk
      );
    },
    async handleTurnCompletion(session) {
      const nextStatus = session.mode === 'task' ? 'completed' : 'idle';
      return store.updateSession(session.id, { status: nextStatus });
    },
    async injectEvolvingCoachBeforeRecovery() {
      /* embed: do not bind evolving */
    },
    runCaseGovernance() {
      /* embed: do not bind case governance */
    },
    scheduleBackgroundCaseReview() {
      /* embed: no background review */
    }
  };
}

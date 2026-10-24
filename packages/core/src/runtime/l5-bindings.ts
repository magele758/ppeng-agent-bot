import { usesDurableBotGoals, reviewDirectGoalBeforeEnd, type GoalRuntimeHost } from '../bots/goals/runtime-host.js';
import { completionModelView, reviewQueryOutput } from '../bots/strict-output.js';
import { observeModelRequests } from './request-metrics.js';
import {
  commitPrepareSnapshot,
  createPrepareSlot,
  linkPrepareSlot,
  type PrepareSlot
} from './snapshot-request-metrics.js';
import { resolveBotWindowBudget } from '../session/history/window.js';
import { BotFunctionalGroupService } from '../bots/functional-groups.js';
import { hasRevokedSharedContext } from '../bots/shared-context-isolation.js';
import { noteHumanModelInput } from '../session/human-continuation.js';
import { isCanonicalBotChat } from '../session/bot-compact-policy.js';
import { estimateMessageTokens } from '../model/token-estimate.js';
/**
 * L5 host adapters: session/scheduler/spawn/compact/kernel bindings for RawAgentRuntime.
 */

import type { ApprovalPolicy } from '../approval/approval-policy.js';
import {
  armUnattendedApprovalExpiry,
  expireDueUnattendedApprovals
} from '../approval/unattended-approval.js';
import type { FileApprovalPolicy } from '../approval/policy-loader.js';
import type { ExtensionRegistry } from '../extensions/extension-registry.js';
import type { Logger } from '../logger.js';
import type { PromptBuilder } from '../model/prompt-builder.js';
import type { AgentSandbox } from '../sandbox/agent-sandbox-types.js';
import type { AutonomousScheduler } from '../services/autonomous-scheduler.js';
import type { ImageIngestService } from '../services/image-ingest-service.js';
import type { SqliteStateStore } from '../storage.js';
import type { TraceEvent } from '../stores/trace.js';
import { envInt } from '../env.js';
import { checkToolBindingPin, markBindingNeedsReverify } from '../discovery/cbom.js';
import { resolveDiscoveryEnabled } from '../discovery/settings.js';
import { resolveSessionModelAdapter, type ModelRef } from '../model/provider-catalog.js';
import { planModelFallback, rememberServedBy, runWithFallbackChain } from '../model/fallback-chain.js';
import { resolveModelRoute, withProviderFallback } from '../model/registry-router.js';
import { waitSteeringChildrenIdle } from '../session/steering-subagent.js';
import { runCaseGovernance } from '../evolving/case-governance.js';
import { scheduleBackgroundCaseReview } from '../evolving/index.js';
import { buildSkillProposeReminder } from '../skill-proposals/reminder.js';
import { readWorkingLogAppendix } from '../session/working-log.js';
import { imageBufferToDataUrl, touchImageAccess } from '../image-assets.js';
import type {
  ModelAdapter,
  ModelStreamChunk,
  ModelTurnResult,
  SessionRecord,
  ToolContract
} from '../types.js';
import { hydrateTurnDynTools, mergeDynToolsUsed, readDynToolsUsed } from '../dyn-tools/hydrate.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { foldGoalJudgeSnapshot } from '../turn/goal-snapshot.js';
import {
  filterToolsForSession,
  resolveTurnTools as selectTurnTools
} from '../turn/resolve-turn-tools.js';
import { runLifecycleHook as runEnvLifecycleHook } from '../hooks/lifecycle-hooks.js';
import { createGoalGateFromMetadata, resolveGoalCondition } from '../goal/goal-gate.js';
import { attachGoalText } from '../stores/trace-visible.js';
import {
  ensureGoalEntityFromMetadata,
  markGoalWaitingUser,
  persistGoalAfterEval
} from '../goal/entity.js';
import { runGoalVerify } from '../goal/run-verify.js';
import { readGoalSettings } from '../goal/settings.js';
import { tryGoalStore } from '../goal/goal-store.js';
import { resolveSteerInterruptPolicy } from '../session/steer-interrupt.js';
import {
  createKernelHookRegistry,
  createStreamResetTracker,
  recoveryPolicyEnabled,
  reasoningSpinWatchdogEnabled,
  registerKernelHooks
} from '@ppeng/agent-loop';
import type { KernelHookListener, KernelHookRegistry } from '@ppeng/agent-loop';
import { runProfileFromSession } from '../runtime/run-profile.js';
import { lastUserQueryFromMessages } from '../session/context-compiler.js';
import { latestCheckpoint, rewindUncommittedTail } from '../session/checkpoint.js';
import { createEventLogStepTx } from '../session/event-log-saga.js';
import { resolveEffectiveWorkspace } from '../workspace/effective.js';
import { defaultWorkspaceRoots } from '../workspace/resolve.js';
import { AUTO_FORK_USED_KEY } from '../session/auto-fork.js';
import type { WorkspaceManager } from '../workspaces.js';
import type { CronJobStore } from '../cron/cron-store.js';
import type { CronFacadeHost } from '../cron/cron-facade.js';
import {
  filePolicyRequiresBashApproval,
  filePolicyRequiresPathApproval
} from '../approval/policy-loader.js';
import { lifecycleBlocks, runLifecycleHook } from '../hooks/lifecycle-hooks.js';
import { maybeExportOtelSpan } from '../otel.js';
import { redactToolContent } from '../sandbox/result-redaction.js';
import {
  getBoundSecretVault,
  parseSecretRefs,
  runWithSecretRefs
} from '../secrets/secret-vault.js';
import { resolveWorkspacePath } from '../workspace/resolve.js';
import type { AssembledLoopIo } from '@ppeng/agent-loop';
import type { FileApprovalPolicy as LoopFilePolicy } from '@ppeng/agent-loop';
import {
  checkToolApprovals as toolLoopCheckApprovals,
  checkToolApprovalsForLoop,
  executeToolCalls as toolLoopExecuteCalls,
  filterValidToolCalls as toolLoopFilterValid,
  processToolResults as toolLoopProcessResults,
  runTurnWithRetries as toolLoopRunTurn,
  type ToolLoopDeps
} from './tool-loop.js';
import {
  applyJevCompactView,
  applyJevContextSelect,
  applyJevPreTurn,
  applyJevRecoveryChoice,
  applyJevRoute,
  applyJevToolGate,
  applyJevToolSelect,
  selectGoalJudge
} from '../jev/apply.js';
import { chainHas, resolveJevChain } from '../jev/settings.js';
import { createToolServices as buildToolServices } from './tool-services.js';
import {
  applyOptionalFoldBudget as applyOptionalFoldBudgetView,
  prepareMessagesForModel as prepareMessagesForModelView,
  type PrepareViewHost
} from '../turn/prepare-view.js';
import type { TurnKernelHost } from '../turn/host.js';
import { autoCompactSession } from './compact-host.js';
import { applyNormalSessionRequestBudget } from './normal-request-guard.js';
import { resolveMaxContextTokens } from '../session/session-budget.js';
import {
  preparedContextSnapshotBlocksFor,
  type ContextSnapshotBlock
} from '../session/context-snapshots.js';
import { autoClaimTask, ingestMailbox, unblockDependentTasks } from './scheduler-host.js';
import { handleTurnCompletion, injectEvolvingCoachBeforeRecovery } from './session-complete.js';
import { resolveSkillLoad, resolveSkillSearch } from './skill-load.js';
import {
  ensureWorkspaceRoot,
  spawnSubagent,
  spawnSubagentOutcome,
  spawnTeammate,
  spawnTeammateOutcome,
  startBackgroundJob,
  type SpawnHost
} from './spawn-host.js';
import type { SessionFacadeHost } from './session-facade.js';
import type { CompactHost } from './compact-host.js';
import type { SessionCompleteHost } from './session-complete.js';
import type { SchedulerTickHost } from './scheduler-host.js';

export interface L5Bindable {
  goalRuntimeHost?(): GoalRuntimeHost;
  store: SqliteStateStore;
  repoRoot: string;
  stateDir: string;
  tools: ToolContract<any>[];
  /** Refresh granted plugin tools onto `tools` before a turn. Domain mounts stay put. */
  syncConnectorTools?(): void;
  filterSoftwareTools?(tools: ToolContract<any>[], session: SessionRecord): ToolContract<any>[];
  modelAdapter: ModelAdapter;
  promptBuilder: PromptBuilder;
  mcpManager: { ensureLoaded(sessionId: string): Promise<void> };
  extensionRegistry: ExtensionRegistry;
  maxTurnsPerRun: number;
  maxParallelToolCalls: number;
  envApprovalPolicy: ApprovalPolicy | undefined;
  turnShapeBySession: Map<string, { systemPromptChars: number; toolCount: number }>;
  cumulativeInputTokensBySession: Map<string, { cumulative: number; sticky: boolean }>;
  sessionAbortControllers: Map<string, AbortController>;
  workspaceManager: WorkspaceManager;
  sandbox: AgentSandbox | undefined;
  setSandbox(sandbox: AgentSandbox): void;
  backgroundJobAborts: Map<string, AbortController>;
  cronStore: CronJobStore | undefined;
  setCronStore(store: CronJobStore): void;
  selfHeal: { processRuns(): Promise<void> };
  swarmExecutor: { tick(): Promise<unknown> };
  teamDagExecutor?: { tick(): Promise<unknown> };
  orchestrationEngine: { tick(): Promise<unknown> };
  autonomousScheduler: AutonomousScheduler;
  imageIngest: Pick<ImageIngestService, 'runRetention'>;
  log: Logger;
  emitTrace(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void;
  mergeSessionMetadata(sessionId: string, patch: Record<string, unknown>): SessionRecord;
  mergedFilePolicy(): Promise<FileApprovalPolicy | undefined>;
  runSession(sessionId: string): Promise<SessionRecord>;
  cancelSession(sessionId: string): void;
  isSessionRunning?(sessionId: string): boolean;
  hasUnconfirmedEffects?(sessionId: string, startedAt: string): boolean;
  hooks?: KernelHookRegistry;
}

export function mergeKernelHookRegistries(
  ...registries: Array<KernelHookRegistry | undefined>
): KernelHookRegistry {
  const merged = createKernelHookRegistry();
  for (const registry of registries) {
    if (!registry) continue;
    registerKernelHooks(merged, (event) => {
      void registry.onEvent(event);
    });
  }
  return merged;
}

export function fanoutKernelLatch<TEvent>(
  latch: { emit(event: TEvent): Promise<void> } | undefined,
  hooks: KernelHookRegistry,
  onEvent?: KernelHookListener
): { emit(event: TEvent): Promise<void> } {
  return {
    async emit(event) {
      if (latch) await latch.emit(event);
      await hooks.onEvent(event as Parameters<KernelHookListener>[0]);
      if (onEvent) await onEvent(event as Parameters<KernelHookListener>[0]);
    }
  };
}

export function bindMemoryAppendixPrompt(rt: Pick<L5Bindable, 'promptBuilder' | 'stateDir'> & Partial<Pick<L5Bindable, 'store'>>): TurnKernelHost['promptBuilder'] {
  const prompt = rt.promptBuilder;
  const sharedContext = rt.store ? new BotFunctionalGroupService(rt.store) : undefined;
  return {
    get lastCognitivePhaseBySession() {
      return prompt.lastCognitivePhaseBySession;
    },
    getRouting: (sessionId) => prompt.getRouting(sessionId),
    buildStablePrefix: (ctx) => prompt.buildStablePrefix(ctx),
    buildSystemPrompt: (ctx, messages) => prompt.buildSystemPrompt(
      rt.store && hasRevokedSharedContext(rt.store,ctx.session.id)
        ? {...ctx,session:{...ctx.session,summary:undefined,todo:[]}}
        : ctx, messages),
    buildMemoryAppendix: async (ctx, opts) => {
      const memory = await prompt.buildMemoryAppendixAsync(ctx, {
        query: opts?.query,
        stateDir: opts?.stateDir ?? rt.stateDir
      });
      const appendix=memory + (sharedContext?.appendix(ctx.session) ?? '');
      // A nonempty boundary also prevents either kernel's working-log fallback
      // from reintroducing unproven summaries of a departed group's context.
      return appendix || (rt.store && hasRevokedSharedContext(rt.store,ctx.session.id)
        ? '[sharing-domain-changed] Previous group-derived context is unavailable. Use only currently authorized shared facts and unrevoked sources.'
        : '');
    }
  };
}

export function sessionFacadeFrom(rt: L5Bindable): SessionFacadeHost {
  return {
    store: rt.store,
    runImageRetention: (sessionId) => rt.imageIngest.runRetention(sessionId),
    wakeAllAutonomousSessions: (reason) => rt.autonomousScheduler.wakeAll(reason),
    wakeAgentSessions: (agentId, reason) => rt.autonomousScheduler.wakeAgent(agentId, reason)
  };
}

export function cronFacadeFrom(rt: L5Bindable): CronFacadeHost {
  return {
    ...sessionFacadeFrom(rt),
    stateDir: rt.stateDir,
    cronStore: rt.cronStore,
    setCronStore: (store) => rt.setCronStore(store)
  };
}

export function schedulerFrom(rt: L5Bindable): SchedulerTickHost {
  return {
    store: rt.store,
    stateDir: rt.stateDir,
    log: rt.log,
    cronStore: rt.cronStore,
    setCronStore: (store) => rt.setCronStore(store),
    selfHeal: rt.selfHeal,
    swarmExecutor: rt.swarmExecutor,
    teamDagExecutor: rt.teamDagExecutor,
    orchestrationEngine: rt.orchestrationEngine,
    autonomousScheduler: rt.autonomousScheduler,
    runSession: (sid) => rt.runSession(sid),
    isSessionRunning: (sid) => rt.isSessionRunning?.(sid) ?? false,
    hasUnconfirmedEffects: (sid, since) => rt.hasUnconfirmedEffects?.(sid, since) ?? false,
    cancelSession: (sid) => rt.cancelSession(sid)
  };
}

export function spawnFrom(rt: L5Bindable): SpawnHost {
  return {
    ...sessionFacadeFrom(rt),
    repoRoot: rt.repoRoot,
    stateDir: rt.stateDir,
    workspaceManager: rt.workspaceManager,
    sandbox: rt.sandbox,
    setSandbox: (sandbox) => rt.setSandbox(sandbox),
    backgroundJobAborts: rt.backgroundJobAborts,
    runSession: (sid) => rt.runSession(sid),
    cancelSession: (sid) => rt.cancelSession(sid)
  };
}

const activeContextAdapters = new WeakMap<object, Map<string, ModelAdapter>>();
function activeAdapters(rt: L5Bindable): Map<string, ModelAdapter> {
  let map = activeContextAdapters.get(rt);
  if (!map) { map = new Map(); activeContextAdapters.set(rt, map); }
  return map;
}

/** Repack against the actual candidate, including smaller fallback windows. */
async function invokeContextModel(
  rt: L5Bindable, adapter: ModelAdapter,
  input: Parameters<TurnKernelHost['runTurnWithRetries']>[0],
  onStream: Parameters<TurnKernelHost['runTurnWithRetries']>[1],
  retries?: { maxRetries: number }
): Promise<ModelTurnResult> {
  const session = input.sessionId ? rt.store.getSession(input.sessionId) : undefined;
  if (!session || !isCanonicalBotChat(session)) {
    if (input.sessionId) noteHumanModelInput(rt.store, input.sessionId, input.messages);
    return toolLoopRunTurn(observeModelRequests(rt.store, adapter, rt.cumulativeInputTokensBySession), input, onStream, retries);
  }
  activeAdapters(rt).set(session.id, adapter);
  try {
    const shape = {systemPromptChars: input.systemPrompt.length, toolSchemaTokens: Math.ceil(JSON.stringify(input.tools.map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}))).length/4)};
    const budget = resolveBotWindowBudget(rt.store, adapter, shape);
    let messages = completionModelView(input.messages);
    let compacted = false;
    const estimated = estimateMessageTokens(messages);
    // Overhead can put the send ceiling under the 50% tier. Compact first, then apply it.
    if (estimated >= budget.structuredTokens || estimated > budget.historyTokens) {
      const host = compactFrom(rt);
      const result = await autoCompactSession(host, {session, agent:input.agent, repoRoot:rt.repoRoot, stateDir:rt.stateDir}, {force:true});
      if (result.replaced) {
        compacted = true;
        const prepared = await host.prepareMessagesForModel(session, rt.store.foldMessages(session.id));
        // Preserve turn-local user memory/image parts when the original message survived.
        const oldById = new Map(messages.filter(message=>message.role==='user').map(message=>[message.id,message]));
        messages = completionModelView(prepared.map(message => oldById.get(message.id) ?? message));
      }
    }
    if (estimateMessageTokens(messages) > budget.historyTokens) {
      throw new Error(`Context length exceeded: actual model window ${budget.contextTokens}, available history ${budget.historyTokens}. Closed tool waves cannot be truncated.`);
    }
    if (!compacted) {
      rt.emitTrace(session.id,{kind:'compact_skipped',payload:{reason:'context_budget',...budget,adapter:adapter.name}});
    }
    noteHumanModelInput(rt.store, session.id, messages);
    return await toolLoopRunTurn(observeModelRequests(rt.store, adapter, rt.cumulativeInputTokensBySession), {...input,messages}, onStream, retries);
  } finally { activeAdapters(rt).delete(session.id); }
}

export function compactFrom(rt: L5Bindable): CompactHost {
  return {
    store: rt.store,
    stateDir: rt.stateDir,
    modelAdapter: rt.modelAdapter,
    resolveModelAdapter: (session) =>
      resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter),
    resolveContextAdapter: (session) => activeAdapters(rt).get(session.id) ?? resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter),
    extensionRegistry: rt.extensionRegistry,
    turnShapeBySession: rt.turnShapeBySession,
    emitTrace: (sessionId, event) => rt.emitTrace(sessionId, event),
    prepareMessagesForModel: (session, messages) =>
      prepareMessagesForModelView(prepareViewFrom(rt), session, messages)
  };
}

export function sessionCompleteFrom(rt: L5Bindable): SessionCompleteHost {
  return {
    store: rt.store,
    stateDir: rt.stateDir,
    emitTrace: (sessionId, event) => rt.emitTrace(sessionId, event),
    mergeSessionMetadata: (sessionId, patch) => rt.mergeSessionMetadata(sessionId, patch)
  };
}

export function prepareViewFrom(rt: L5Bindable): PrepareViewHost {
  return {
    store: rt.store,
    emitTrace: (sessionId, event) => {
      rt.emitTrace(sessionId, event as Parameters<TurnKernelHost['emitTrace']>[1]);
    },
    turnShapeBySession: rt.turnShapeBySession,
    promptBuilder: rt.promptBuilder
  };
}

export function toolLoopDepsFrom(rt: L5Bindable): ToolLoopDeps {
  return {
    tools: rt.tools,
    store: rt.store,
    envApprovalPolicy: rt.envApprovalPolicy,
    maxParallelToolCalls: rt.maxParallelToolCalls,
    modelAdapter: rt.modelAdapter,
    stateDir: rt.stateDir,
    emitTrace: (sessionId, event) => {
      void rt.emitTrace(sessionId, {
        kind: event.kind as TraceEvent['kind'],
        payload: event.payload
      });
    },
    runAfterToolExtension: async (ctx) => {
      const r = await rt.extensionRegistry.run('after_tool', {
        sessionId: ctx.sessionId,
        tool: ctx.tool,
        input: ctx.input,
        ok: ctx.ok,
        content: ctx.content
      });
      return r.systemMessage ? { systemMessage: r.systemMessage } : undefined;
    },
    settingsStore: rt.store,
    armUnattendedApproval: (approval) => {
      armUnattendedApprovalExpiry(approval, () => {
        expireDueUnattendedApprovals(rt.store);
      });
    },
    onArtifactCreated: (manifest) => {
      try {
        rt.store.createArtifactIndex({
          id: manifest.handle,
          sessionId: manifest.sessionId,
          sourceTool: manifest.sourceTool,
          fileName: manifest.fileName,
          mimeType: manifest.mimeType,
          localRelPath: manifest.storageRelPath,
          totalBytes: manifest.totalBytes,
          totalChars: manifest.totalChars,
          pageSizeChars: manifest.pageSizeChars,
          totalPages: manifest.totalPages,
          createdAt: manifest.createdAt
        });
      } catch {
        /* index is best-effort; files remain readable */
      }
    },
    checkCapabilityPin: (toolName, inputSchema) => {
      if (!resolveDiscoveryEnabled(rt.store, process.env)) {
        return { ok: true };
      }
      const store = rt.store.capabilities();
      const result = checkToolBindingPin(store, toolName, inputSchema);
      if (!result.ok && result.bindingId) {
        try {
          markBindingNeedsReverify(store, result.bindingId);
        } catch {
          /* best-effort */
        }
      }
      return result;
    }
  };
}

export function createRuntimeToolServices(rt: L5Bindable) {
  return buildToolServices({
    store: rt.store,
    stateDir: rt.stateDir,
    resolveSkillLoad: (name, sessionId) => resolveSkillLoad({
      promptBuilder: rt.promptBuilder,
      emitTrace: (id, event) => rt.emitTrace(id, event)
    }, name, sessionId),
    resolveSkillSearch: (query, sessionId, limit) => resolveSkillSearch({
      promptBuilder: rt.promptBuilder,
      emitTrace: (id, event) => rt.emitTrace(id, event)
    }, query, sessionId, limit),
    unblockDependentTasks: (taskId) => unblockDependentTasks(rt.store, taskId),
    spawnSubagent: (context, prompt, role, opts) =>
      spawnSubagent(spawnFrom(rt), context, prompt, role, opts),
    spawnSubagentOutcome: (context, prompt, role, opts) =>
      spawnSubagentOutcome(spawnFrom(rt), context, prompt, role, opts),
    spawnTeammate: (context, input) => spawnTeammate(spawnFrom(rt), context, input),
    spawnTeammateOutcome: (context, input) => spawnTeammateOutcome(spawnFrom(rt), context, input),
    startBackgroundJob: (sessionId, command, options) =>
      startBackgroundJob(spawnFrom(rt), sessionId, command, options),
    compactContext: async (context, opts) => {
      const compacted = await autoCompactSession(compactFrom(rt), context, opts);
      if (compacted.replaced) {
        return `Compacted seq ${compacted.replaced.startSeq}–${compacted.replaced.endSeq}.`;
      }
      return 'No compaction applied (under threshold or open tool wave).';
    }
  });
}

/**
 * Global fallback chain (Lab "模型备选"). Returns `undefined` when the chain is
 * empty / unusable so callers keep their legacy model routing unchanged.
 */
function runTurnViaFallbackChain(
  rt: L5Bindable,
  input: Parameters<TurnKernelHost['runTurnWithRetries']>[0],
  onStream: Parameters<TurnKernelHost['runTurnWithRetries']>[1],
  primary: ModelAdapter,
  primaryRef?: ModelRef | null
): Promise<ModelTurnResult> | undefined {
  const sessionId = input.sessionId;
  const session = sessionId ? rt.store.getSession(sessionId) : undefined;
  const plan = planModelFallback({
    store: rt.store,
    session,
    primary,
    ...(primaryRef !== undefined ? { primaryRef } : {}),
    env: process.env
  });
  if (sessionId) rememberServedBy(sessionId, undefined);
  if (!plan) return undefined;
  const stream = fallbackStream(onStream);
  return runWithFallbackChain({
    candidates: plan.candidates,
    signal: input.signal,
    onServed: (served) => {
      if (sessionId) rememberServedBy(sessionId, served);
    },
    emitTrace: (event) => {
      if (sessionId) rt.emitTrace(sessionId, event as Parameters<L5Bindable['emitTrace']>[1]);
    },
    // The primary uses the configured retry budget; backups get at most one retry.
    invoke: (adapter, index) =>
      invokeContextModel(rt, adapter, input, stream.forAttempt(index, adapter), index === 0 ? undefined : { maxRetries: 1 })
  });
}

type ModelTurnCall = TurnKernelHost['runTurnWithRetries'];

/** Blocks are captured at queue time. Only the SQLite write waits. */
interface QueuedPreparedSnapshot {
  sessionId: string;
  blocks: ContextSnapshotBlock[];
  slot: PrepareSlot;
}

interface PreparedSnapshotQueue extends Array<QueuedPreparedSnapshot> {
  /** Set while a drain macrotask is waiting, so a second one is not armed. */
  scheduled?: NodeJS.Immediate;
  /** Set while a failed write is waiting to be retried. unref'd. */
  retry?: NodeJS.Timeout;
}

const pendingPreparedSnapshots = new WeakMap<L5Bindable['store'], PreparedSnapshotQueue>();

/**
 * Write one queued snapshot. A closed store or a thrown append leaves the item
 * queued so the next flush or drain can retry it. Ordering is per session, so
 * a failure blocks only that session.
 */
function writeQueuedPreparedSnapshot(store: L5Bindable['store'], item: QueuedPreparedSnapshot): boolean {
  if (!store.db.isOpen) return false;
  try {
    const snapshot = store.appendContextSnapshot(item.sessionId, item.blocks);
    if (snapshot?.id) commitPrepareSnapshot(store, item.slot, snapshot.id);
    return true;
  } catch {
    return false;
  }
}

function cancelPreparedSnapshotSchedule(queue: PreparedSnapshotQueue | undefined): void {
  if (!queue) return;
  if (queue.scheduled) clearImmediate(queue.scheduled);
  if (queue.retry) clearTimeout(queue.retry);
  delete queue.scheduled;
  delete queue.retry;
}

/**
 * Write queued replay snapshots now, in prepare order within each session.
 * Readers call this first so a listed history always includes every prepare
 * that already happened. A session whose write fails keeps that item and every
 * later item of the same session queued; other sessions keep being written.
 */
export function flushPreparedContextSnapshots(store: L5Bindable['store'], sessionId?: string): void {
  const queue = pendingPreparedSnapshots.get(store);
  if (!queue?.length) return;
  cancelPreparedSnapshotSchedule(queue);
  const blocked = new Set<string>();
  const keep: QueuedPreparedSnapshot[] = [];
  for (const item of queue.splice(0)) {
    const selected = sessionId === undefined || item.sessionId === sessionId;
    if (!selected || blocked.has(item.sessionId) || !writeQueuedPreparedSnapshot(store, item)) {
      keep.push(item);
      if (selected) blocked.add(item.sessionId);
    }
  }
  queue.push(...keep);
  // Flush cancels the scheduled drain, so anything still queued (a write that
  // failed, or another session a per-session flush skipped) has to be re-armed
  // or it sits in memory until exit. A drain that writes nothing falls back to
  // the unref'd retry.
  if (queue.length && store.db.isOpen) schedulePreparedSnapshotDrain(store, queue);
}

/**
 * Storing a prepared-view snapshot copies the whole context (block text, JSON).
 * Doing that inline on every prepared model request made back-to-back bot turns
 * one long synchronous burst that starved HTTP handlers. Blocks are built when
 * the request is prepared; only the SQLite write waits for the next macrotask.
 * The request itself is unchanged.
 */
function drainOnePreparedSnapshot(store: L5Bindable['store']): void {
  const queue = pendingPreparedSnapshots.get(store);
  if (!queue?.length) return;
  // One successful write per macrotask. A failed session stays queued, in
  // order, and is skipped for the rest of this pass so other sessions proceed.
  const blocked = new Set<string>();
  let wrote = false;
  for (let index = 0; index < queue.length && !wrote;) {
    const next = queue[index];
    if (!next || blocked.has(next.sessionId)) {
      index += 1;
      continue;
    }
    if (writeQueuedPreparedSnapshot(store, next)) {
      queue.splice(index, 1);
      wrote = true;
      continue;
    }
    blocked.add(next.sessionId);
    index += 1;
  }
  if (!queue.length || !store.db.isOpen) return;
  // Healthy items keep the one-per-macrotask pace. Only a leftover failure waits.
  if (wrote) schedulePreparedSnapshotDrain(store, queue);
  else schedulePreparedSnapshotRetry(store, queue);
}

/** True while either the next macrotask or a failure retry is already waiting. */
function snapshotDrainPending(queue: PreparedSnapshotQueue): boolean {
  return queue.scheduled !== undefined || queue.retry !== undefined;
}

function schedulePreparedSnapshotDrain(store: L5Bindable['store'], queue: PreparedSnapshotQueue): void {
  if (snapshotDrainPending(queue)) return;
  queue.scheduled = setImmediate(() => {
    delete queue.scheduled;
    drainOnePreparedSnapshot(store);
  });
}

/** Retry after a failed write. unref so a stuck snapshot cannot hold the process open. */
function schedulePreparedSnapshotRetry(store: L5Bindable['store'], queue: PreparedSnapshotQueue): void {
  if (snapshotDrainPending(queue) || !store.db.isOpen) return;
  const timer = setTimeout(() => {
    delete queue.retry;
    if (!store.db.isOpen) return;
    drainOnePreparedSnapshot(store);
  }, 1000);
  timer.unref();
  queue.retry = timer;
}

export function queuePreparedContextSnapshot(
  store: L5Bindable['store'],
  sessionId: string,
  blocks: ContextSnapshotBlock[]
): PrepareSlot {
  let queue = pendingPreparedSnapshots.get(store);
  if (!queue) {
    queue = [];
    pendingPreparedSnapshots.set(store, queue);
  }
  const slot = createPrepareSlot(sessionId);
  queue.push({ sessionId, blocks, slot });
  if (!snapshotDrainPending(queue)) schedulePreparedSnapshotDrain(store, queue);
  return slot;
}

/**
 * Ordinary chats are capped here, after micro-compact has already shaped
 * `messages` and the kernel has attached the system prompt and tool schemas.
 * Canonical bot chats are left untouched.
 */
function fitProductModelRequest(
  rt: L5Bindable,
  input: Parameters<ModelTurnCall>[0]
): Promise<Parameters<ModelTurnCall>[0]> {
  const session = input.sessionId ? rt.store.getSession(input.sessionId) : undefined;
  const adapter = session
    ? resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter)
    : rt.modelAdapter;
  let slot: PrepareSlot | undefined;
  if (session) {
    try {
      const blocks = preparedContextSnapshotBlocksFor(rt.store, {
        session,
        systemPrompt: input.systemPrompt,
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        messages: [...input.messages],
        adapter,
        env: process.env
      });
      slot = queuePreparedContextSnapshot(rt.store, session.id, blocks);
    } catch {
      /* Replay history must not change the turn or write a summary. */
    }
  }
  return applyNormalSessionRequestBudget(input, {
    session,
    store: rt.store,
    stateDir: rt.stateDir,
    maxContextTokens: resolveMaxContextTokens(process.env),
    emitTrace: (event) => {
      if (!input.sessionId) return;
      rt.emitTrace(input.sessionId, {
        kind: event.kind,
        payload: event.payload
      });
    },
    summarize: (messages) =>
      adapter.summarizeMessages({
        agent: input.agent,
        messages,
        reason: `compact session ${input.sessionId ?? session?.id ?? ''}`
      })
  }).then(fitted => {
    if (fitted.sessionId) noteHumanModelInput(rt.store, fitted.sessionId, fitted.messages);
    if (slot && fitted.sessionId && fitted.messages) {
      linkPrepareSlot(rt.store, fitted.sessionId, fitted.messages, slot);
    }
    return fitted;
  });
}

function runTurnWithNormalRequestBudget(
  rt: L5Bindable,
  input: Parameters<ModelTurnCall>[0],
  onStream: Parameters<ModelTurnCall>[1],
  deliver: ModelTurnCall
): Promise<ModelTurnResult> {
  return fitProductModelRequest(rt, input).then((fitted) => deliver(fitted, onStream));
}

/**
 * A fallback candidate re-streams the whole turn. Before it starts, tell the client
 * to drop what the failed candidate already streamed (`stream_reset`), the same
 * contract retries use. Only the winning attempt reaches the transcript.
 */
function fallbackStream(onStream: Parameters<TurnKernelHost['runTurnWithRetries']>[1]) {
  let priorRequests = 0;
  let currentRequests = 0;
  let lastFailure: Extract<ModelStreamChunk, { type: 'model_retry' }> | undefined;
  const tracker = onStream ? createStreamResetTracker(onStream) : undefined;
  return {
    forAttempt(index: number, adapter: ModelAdapter) {
      if (index > 0) {
        priorRequests += currentRequests;
        currentRequests = 0;
        tracker?.resetIfDirty('fallback');
        if (lastFailure) onStream?.({ ...lastFailure, phase: 'switching', model: adapter.modelName ?? adapter.name,
          retry: 0, maxRetries: 1, requests: priorRequests });
      }
      return onStream ? (chunk: ModelStreamChunk) => {
        if (chunk.type === 'model_retry') {
          currentRequests = chunk.requests;
          if (chunk.phase === 'failed') lastFailure = chunk;
          tracker!.onChunk({ ...chunk, requests: priorRequests + currentRequests });
        } else tracker!.onChunk(chunk);
      } : undefined;
    }
  };
}

function jevToolGateForCalls(
  store: Parameters<typeof applyJevToolGate>[0],
  sessionId: string,
  calls: Parameters<typeof applyJevToolGate>[2],
  closure: { reported: boolean; ids: string[] } | undefined,
  settledApprovalIds?: readonly string[]
) {
  return applyJevToolGate(store, sessionId, calls, {
    settledApprovalIds,
    alreadyClosedIds: closure?.ids,
    markClosed(ids) {
      if (!closure) return;
      closure.reported = true;
      for (const id of ids) {
        if (!closure.ids.includes(id)) closure.ids.push(id);
      }
    }
  });
}

export function bindTurnKernelHost(rt: L5Bindable): TurnKernelHost {
  return {
    store: rt.store,
    repoRoot: rt.repoRoot,
    stateDir: rt.stateDir,
    tools: rt.tools,
    ...(rt.syncConnectorTools ? { syncConnectorTools: () => rt.syncConnectorTools!() } : {}),
    modelAdapter: rt.modelAdapter,
    resolveModelAdapter: (session) =>
      resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter),
    promptBuilder: bindMemoryAppendixPrompt(rt),
    mcpManager: rt.mcpManager,
    extensionRegistry: rt.extensionRegistry,
    maxTurnsPerRun: rt.maxTurnsPerRun,
    turnShapeBySession: rt.turnShapeBySession,
    cumulativeInputTokensBySession: rt.cumulativeInputTokensBySession,
    sessionAbortControllers: rt.sessionAbortControllers,
    emitTrace: (sessionId, event) => rt.emitTrace(sessionId, event),
    mergeSessionMetadata: (sessionId, patch) => rt.mergeSessionMetadata(sessionId, patch),
    ensureWorkspaceRoot: (session, task) => ensureWorkspaceRoot(spawnFrom(rt), session, task),
    ingestMailbox: (session) => ingestMailbox(rt.store, session),
    autoClaimTask: (session) => autoClaimTask(rt.store, session),
    applyFoldBudget: (session, folded) =>
      applyOptionalFoldBudgetView(prepareViewFrom(rt), session, folded),
    loopConfig: {
      maxTurns: rt.maxTurnsPerRun,
      compactEveryTurn: true,
      foldBudgetClamp: true,
      recoveryEnabled: recoveryPolicyEnabled(process.env),
      spinWatchdog: reasoningSpinWatchdogEnabled(process.env),
      forceAnswerOnLastTurn: true,
      overflowSkipAppendix: true,
      budgetTokens: envInt(process.env, 'RAW_AGENT_TOKEN_BUDGET', 0) || undefined
    },
    env: process.env,
    hooks: rt.hooks,
    resolveRunProfile: (session) => runProfileFromSession(session),
    resolveTask: (session) => (session.taskId ? rt.store.getTask(session.taskId) : undefined),
    recordToolUse: ({ name, sessionId, turn, ok }) => {
      if (!ok) return;
      const dynStore = tryCreateDynToolStore(rt.store);
      const rec = dynStore?.recordUse(name, sessionId, turn);
      if (!rec) return;
      const current = rt.store.getSession(sessionId);
      const prev = readDynToolsUsed(current ?? { metadata: {} });
      rt.mergeSessionMetadata(sessionId, { dynToolsUsed: mergeDynToolsUsed(prev, [name]) });
    },
    noteGoalWaitingUser: (sessionId, toolCalls) => {
      if (!toolCalls.some((c) => c.name === 'ask_user')) return;
      markGoalWaitingUser(tryGoalStore(rt.store), sessionId);
    },
    shouldLatchBeforeTools: ({ session }) => {
      const policy = resolveSteerInterruptPolicy({
        sessionMetadata: session.metadata,
        store: rt.store
      });
      if (policy !== 'steer') return 'proceed';
      const pending =
        typeof rt.store.listUnclaimedInbox === 'function'
          ? rt.store.listUnclaimedInbox(session.id)
          : [];
      return pending.some((item) => item.target === 'next-step') ? 'steer' : 'proceed';
    },
    mergedFilePolicy: () => rt.mergedFilePolicy(),
    autoCompact: (context, opts) => autoCompactSession(compactFrom(rt), context, opts),
    prepareMessagesForModel: async (session, messages) => {
      const prepared = await prepareMessagesForModelView(prepareViewFrom(rt), session, messages);
      const taskText = lastUserQueryFromMessages(messages);
      const selected = await applyJevContextSelect(rt.store, prepared, taskText);
      return applyJevCompactView(rt.store, selected ?? prepared);
    },
    applyOptionalFoldBudget: (session, folded) =>
      applyOptionalFoldBudgetView(prepareViewFrom(rt), session, folded),
    resolveImageDataUrl: async (assetId, sessionId) => {
      const asset = rt.store.getImageAsset(assetId);
      if (!asset || asset.sessionId !== sessionId) {
        return undefined;
      }
      await touchImageAccess(rt.store, assetId);
      return imageBufferToDataUrl(rt.store, rt.stateDir, assetId);
    },
    runTurnWithRetries: (input, onStream) =>
      runTurnWithNormalRequestBudget(rt, input, onStream, (fitted, stream) => {
        const session = fitted.sessionId ? rt.store.getSession(fitted.sessionId) : undefined;
        const route = resolveModelRoute({
          store: rt.store,
          session,
          env: process.env,
          fallbackAdapter: rt.modelAdapter
        });
        const chained = runTurnViaFallbackChain(rt, fitted, stream, route.primary, route.primaryRef ?? null);
        if (chained) return chained;
        const candidates = route.candidates.map((adapter, i) => ({
          adapter,
          label: i === 0 ? 'primary' : `fallback-${i}`
        }));
        if (candidates.length <= 1) {
          const adapter = route.primary ?? (session
            ? resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter)
            : rt.modelAdapter);
          return invokeContextModel(rt, adapter, fitted, stream);
        }
        const reset = fallbackStream(stream);
        return withProviderFallback(candidates, (adapter, index) =>
          invokeContextModel(rt, adapter, fitted, reset.forAttempt(index, adapter), index === 0 ? undefined : { maxRetries: 1 })
        );
      }),
    waitSteeringChildrenIdle: (sessionId) => waitSteeringChildrenIdle(sessionId),

    ensureMcpLoaded: (sessionId) => rt.mcpManager.ensureLoaded(sessionId),
    resolveFilePolicy: () => rt.mergedFilePolicy(),
    resolveWorkspaceRoots: async (session) => {
      const task = session.taskId ? rt.store.getTask(session.taskId) : undefined;
      const isolated = await ensureWorkspaceRoot(spawnFrom(rt), session, task);
      if (typeof rt.store.projects === 'function' && typeof rt.store.cloudFolders === 'function') {
        const effective = await resolveEffectiveWorkspace({
          store: rt.store,
          session,
          repoRoot: rt.repoRoot,
          stateDir: rt.stateDir,
          isolatedWorkspaceRoot: isolated
        });
        return effective.workspaceRoots;
      }
      return defaultWorkspaceRoots(isolated, rt.repoRoot);
    },
    resolveTurnTools: async ({ session, agent, messages, systemPromptChars }) => {
      rt.syncConnectorTools?.();
      const query = lastUserQueryFromMessages(messages);
      const routineEnabled = (rt.store.getDaemonControl<{dialogToolsEnabled?:boolean}>('routine.settings')?.dialogToolsEnabled ?? true);
      const botSession = isCanonicalBotChat(session);
      const selectedSession = botSession && routineEnabled ? {...session,metadata:{...session.metadata,enabledOptionalToolGroups:[...new Set([...(Array.isArray(session.metadata?.enabledOptionalToolGroups) ? session.metadata.enabledOptionalToolGroups.map(String) : []),'cron'])]}} : session;
      let catalogTools = rt.filterSoftwareTools?.(rt.tools, session) ?? rt.tools;
      if (botSession && !routineEnabled) catalogTools = catalogTools.filter(tool=>!['cron_create','cron_list','cron_remove','cron_delete','cron_run_now','cron_runs'].includes(tool.name));
      const dynHydrated = hydrateTurnDynTools({
        store: rt.store,
        session,
        query,
        materializeDeps: {
          getAuthorizedTools: (ctx) =>
            filterToolsForSession({
              env: process.env,
              tools: catalogTools,
              agent: ctx.agent,
              session: ctx.session,
              settingsStore: rt.store
            }).tools,
          previewAuthorizedTools: filterToolsForSession({
            env: process.env,
            tools: catalogTools,
            agent,
            session,
            settingsStore: rt.store
          }).tools,
          emitTrace: (sessionId, event) => {
            void rt.emitTrace(sessionId, event as Parameters<TurnKernelHost['emitTrace']>[1]);
          }
        }
      });
      const selected = selectTurnTools({
        env: process.env,
        tools: catalogTools,
        agent,
        session: selectedSession,
        sessionId: session.id,
        systemPromptChars,
        settingsStore: rt.store,
        dynTools: dynHydrated.tools
      });
      let turnTools = selected.turnTools;
      const names = await applyJevToolSelect(
        rt.store,
        query,
        turnTools.map((t) => ({ name: t.name, description: t.description })),
    { preserveExposure: true }
      );
      if (names) {
        const keep = new Set(names);
        turnTools = turnTools.filter((t) => keep.has(t.name));
      }
      return {
        tools: turnTools,
        allowExternalAiTools: selected.allowExternalAiTools,
        promptCacheKey: selected.promptCacheKey,
        metadataPatch: selected.metadataPatch,
        trace:
          dynHydrated.names.length > 0 || dynHydrated.skipped.length > 0
            ? {
                kind: 'dyn_tool_hydrate',
                payload: {
                  names: dynHydrated.names,
                  suggestRetired: dynHydrated.suggestRetired,
                  ...(dynHydrated.skipped.length > 0 ? { skipped: dynHydrated.skipped } : {})
                }
              }
            : undefined
      };
    },
    beforeModelTurn: async ({ session, hasPendingToolCalls }) => {
      if (hasPendingToolCalls) return 'proceed';
      const gate = usesDurableBotGoals(rt.store, session) ? undefined : createGoalGateFromMetadata(session.metadata, process.env);
      const hasGoal = Boolean(gate?.isActive());
      const taskText =
        typeof session.metadata?.goalCondition === 'string'
          ? String(session.metadata.goalCondition)
          : lastUserQueryFromMessages(rt.store.foldMessages(session.id));
      const decision = await applyJevPreTurn(rt.store, taskText, hasGoal);
      if (decision === 'skip_done' && hasGoal) return 'skip_goal_done';
      return 'proceed';
    },
    chooseRecovery: async ({ situation, options, defaultId }) => {
      const picked = await applyJevRecoveryChoice(rt.store, situation, options);
      return picked ?? defaultId;
    },
    evaluateGoalGate: async ({ session, signal, workspaceRoot }) => {
      const snapshot = foldGoalJudgeSnapshot(rt.store, session.id);
      // Soft-stop boundary: one Jev route fan-out before goal / deep-model judge.
      const route = await applyJevRoute(rt.store, { state: snapshot, signal });
      if (route.kind === 'continue') {
        return {
          met: false,
          action: 'continue',
          reason: route.reason,
          systemMessage: `[jev-route] ${route.reason}. Continue working.`
        };
      }

      if (usesDurableBotGoals(rt.store, session) && rt.goalRuntimeHost) {
        const review = await reviewDirectGoalBeforeEnd(rt.goalRuntimeHost(), session.id, signal);
        if (review) return review;
      }
      if (isCanonicalBotChat(session)) {
        const formatReview = reviewQueryOutput(rt.store, session.id, signal);
        if (formatReview) return formatReview;
      }
      const gate = usesDurableBotGoals(rt.store, session) ? undefined : createGoalGateFromMetadata(session.metadata, process.env);
      if (!gate?.isActive()) return { met: true };

      // route.done only fires when goalGate point is off (see applyJevRoute).
      // Skip another deep-model completeText round for completion.
      if (route.kind === 'done') {
        recordJevAchievement(rt, session, route.reason, gate.getTurnsUsed());
        return {
          met: true,
          action: 'achieved',
          reason: route.reason,
          systemMessage: `[jev-route] Achieved: ${route.reason}`
        };
      }

      const goalStore = tryGoalStore(rt.store);
      if (goalStore) {
        try {
          ensureGoalEntityFromMetadata(goalStore, session.id, session.metadata, {
            getDaemonControl: <T>(key: string) => rt.store.getDaemonControl?.(key) as T | undefined
          });
        } catch {
          /* fail-soft */
        }
      }
      const adapter = resolveSessionModelAdapter(rt.store, session, process.env, rt.modelAdapter);
      const fallbackJudge =
        typeof adapter.completeText === 'function'
          ? (input: { system: string; user: string; signal?: AbortSignal }) =>
              adapter.completeText!({ ...input, jsonMode: true })
          : async () => JSON.stringify({ met: true, reason: 'no completeText; fail-open' });
      const judge = selectGoalJudge(rt.store, fallbackJudge);
      const rec = goalStore?.findLatestBySession(session.id);
      const verifySpec = rec?.spec.verify;
      const { evalResult, decision } = await gate.evaluate({
        snapshot,
        judge,
        signal,
        verify: verifySpec
          ? () =>
              runGoalVerify(verifySpec, {
                workspaceRoot: workspaceRoot ?? rt.repoRoot,
                settings: readGoalSettings({
                  getDaemonControl: <T>(key: string) =>
                    rt.store.getDaemonControl?.(key) as T | undefined
                }),
                signal
              })
          : undefined
      });
      rt.mergeSessionMetadata(session.id, gate.metadataPatch());
      if (goalStore) {
        persistGoalAfterEval({
          store: goalStore,
          sessionId: session.id,
          metadata: rt.store.getSession(session.id)?.metadata ?? session.metadata,
          evalResult,
          decision,
          gate
        });
      }
      const judgedSession = rt.store.getSession(session.id) ?? session;
      const judgedGoal = goalStore?.findLatestBySession(session.id);
      void rt.emitTrace(session.id, {
        kind: 'goal_eval',
        payload: attachGoalText({
          met: evalResult.met,
          reason: evalResult.reason,
          source: evalResult.source,
          decision: decision.kind,
          turnsUsed: gate.getTurnsUsed(),
          jevGoalGate: chainHas(resolveJevChain(rt.store), 'goalGate')
        }, {
          goal: resolveGoalCondition(judgedSession.metadata) ?? judgedGoal?.condition,
          title: judgedGoal?.spec.goal
        })
      });
      if (decision.kind === 'continue') {
        return {
          met: false,
          action: 'continue',
          reason: evalResult.reason,
          systemMessage:
            decision.unattendedInstruction ??
            `[goal] Condition not met yet: ${evalResult.reason}. Continue working toward the goal.`
        };
      }
      if (decision.kind === 'close') {
        return {
          met: true,
          action: 'close',
          reason: decision.reason,
          systemMessage: `[goal] Closed (${decision.event}): ${decision.reason}`
        };
      }
      return {
        met: true,
        action: 'achieved',
        reason: evalResult.reason,
        systemMessage: `[goal] Achieved: ${evalResult.reason}`
      };
    },
    runLifecycleHook: async ({ phase, sessionId, agentId, turn, meta }) => {
      const scriptPhase = phase === 'subagent_stop' ? 'stop' : phase;
      let systemMessage: string | undefined;
      if (scriptPhase === 'session_start' || scriptPhase === 'stop') {
        const script = await runEnvLifecycleHook(process.env, {
          phase: scriptPhase,
          sessionId,
          context: { agentId, turn, ...meta }
        });
        if (script.block || script.permissionDecision === 'deny') {
          return { block: true, message: script.message, systemMessage: script.systemMessage };
        }
        systemMessage = script.systemMessage;
      }
      const extPhase = phase === 'subagent_stop' ? 'stop' : phase;
      if (extPhase === 'session_start' || extPhase === 'before_turn' || extPhase === 'stop') {
        const ext = await rt.extensionRegistry.run(extPhase, {
          sessionId,
          agentId,
          meta: { turn, ...meta }
        });
        if (ext.block) {
          return {
            block: true,
            message: ext.message,
            systemMessage: ext.systemMessage ?? systemMessage
          };
        }
        if (ext.systemMessage) {
          systemMessage = [systemMessage, ext.systemMessage].filter(Boolean).join('\n');
        }
      }
      return { systemMessage };
    },
    latestClosedCheckpoint: (sessionId) => latestCheckpoint(rt.store.getSession(sessionId)?.metadata),
    applyAutoFork: ({ session, trigger, checkpointSeq, guidance }) => {
      rewindUncommittedTail(rt.store, session.id, { reason: trigger, toSeq: checkpointSeq });
      rt.mergeSessionMetadata(session.id, { [AUTO_FORK_USED_KEY]: true });
      rt.store.appendMessage(session.id, 'system', [{ type: 'text', text: guidance }]);
      return { applied: true };
    },
    stepTx: createRuntimeStepTx(rt),
    filterValidToolCalls: (toolCalls, allowExternalAiTools, sessionId, turnTools) =>
      toolLoopFilterValid(toolLoopDepsFrom(rt), toolCalls, allowExternalAiTools, sessionId, turnTools),
    checkToolApprovals: async (
      validToolCalls,
      context,
      filePolicy,
      session,
      turnTools,
      closure,
      settledApprovalIds
    ) => {
      const decision = toolLoopCheckApprovals(
        toolLoopDepsFrom(rt),
        validToolCalls,
        context,
        filePolicy,
        session,
        turnTools,
        closure
      );
      if (decision !== 'proceed') return decision;
      return jevToolGateForCalls(rt.store, session.id, validToolCalls, closure, settledApprovalIds);
    },
    executeToolCalls: (validToolCalls, context, allowExternalAiTools, sessionId, turnTools) =>
      toolLoopExecuteCalls(
        toolLoopDepsFrom(rt),
        validToolCalls,
        context,
        allowExternalAiTools,
        sessionId,
        turnTools
      ),
    processToolResults: (results, validToolCalls, session, task, sessionId, onModelStreamChunk) =>
      toolLoopProcessResults(
        toolLoopDepsFrom(rt),
        results,
        validToolCalls,
        session,
        task,
        sessionId,
        onModelStreamChunk
      ),
    handleTurnCompletion: (session, agent, task) =>
      handleTurnCompletion(sessionCompleteFrom(rt), session, agent, task),
    injectEvolvingCoachBeforeRecovery: (session, agent, trigger, reason) =>
      injectEvolvingCoachBeforeRecovery(sessionCompleteFrom(rt), session, agent, trigger, reason),
    runCaseGovernance: () => {
      runCaseGovernance(rt.store.getAgentCaseStore(), process.env);
    },
    scheduleBackgroundCaseReview: (input) => {
      scheduleBackgroundCaseReview(rt.store, process.env, {
        stateDir: rt.stateDir,
        sessionId: input.sessionId,
        agentId: input.agentId,
        outcome: input.outcome,
        signals: input.signals
      });
    }
  };
}

/**
 * EventLog saga + closed-step checkpoints. `SqliteStateStore` satisfies the
 * package's `CheckpointStore` duck-type, so the shared `createEventLogStepTx`
 * writes checkpoints and rewinds the uncommitted tail for us.
 */
export function createRuntimeStepTx(rt: Pick<L5Bindable, 'store'>): NonNullable<TurnKernelHost['stepTx']> {
  return createEventLogStepTx(rt.store);
}

function adaptFilePolicyForLoop(
  policy: Awaited<ReturnType<L5Bindable['mergedFilePolicy']>>
): LoopFilePolicy | undefined {
  if (!policy) return undefined;
  return {
    requireApprovalForBash: Boolean(policy.bashCommandPatterns?.length),
    requiresBashApproval: (cmd) => filePolicyRequiresBashApproval(policy, cmd),
    requiresPathApproval: (toolName, path) => filePolicyRequiresPathApproval(policy, toolName, path)
  };
}

/** Product I/O for `createAssembledLoop`. Does not copy A's tool-loop / EventLog / compact. */
export function l5ToAssembledIo(rt: L5Bindable, sessionId?: string): AssembledLoopIo {
  const host = bindTurnKernelHost(rt);
  const toolDeps = toolLoopDepsFrom(rt);
  const toolIterations = new Set<number>();
  let lastReminderIteration = -1;
  const chainActive = planModelFallback({ store: rt.store, primary: rt.modelAdapter, env: process.env }) !== undefined;
  return {
    model: rt.modelAdapter,
    tools: rt.tools,
    store: rt.store,
    repoRoot: rt.repoRoot,
    stateDir: rt.stateDir,
    env: process.env,
    loopConfig: host.loopConfig,
    maxTurns: rt.maxTurnsPerRun,
    maxParallelToolCalls: rt.maxParallelToolCalls,
    envApprovalPolicy: rt.envApprovalPolicy,
    sessionAbortControllers: rt.sessionAbortControllers,
    emitTrace: (sessionId, event) => {
      rt.emitTrace(sessionId, {
        kind: event.kind as TraceEvent['kind'],
        payload: event.payload ?? event.data
      });
    },
    promptBuilder: {
      ...host.promptBuilder,
      buildMemoryAppendix: async (ctx, opts) => {
        const memory = await host.promptBuilder.buildMemoryAppendix(ctx, opts);
        const reminder = buildSkillProposeReminder({
          settingsStore: rt.store,
          turn: toolIterations.size,
          agent: ctx.agent,
          session: ctx.session
        });
        if (reminder && lastReminderIteration !== toolIterations.size) {
          lastReminderIteration = toolIterations.size;
          void rt.emitTrace(ctx.sessionId, { kind: 'skill_propose_reminder', payload: { turn: toolIterations.size } });
        }
        const appendix = memory || (reminder ? readWorkingLogAppendix(rt.stateDir, ctx.sessionId, process.env) : '');
        return [appendix, reminder].filter(Boolean).join('\n\n');
      }
    },
    mergeSessionMetadata: (sessionId, patch) => rt.mergeSessionMetadata(sessionId, patch),
    ensureMcpLoaded: (sessionId) => rt.mcpManager.ensureLoaded(sessionId),
    ensureWorkspaceRoot: (session, task) => host.ensureWorkspaceRoot(session, task),
    resolveWorkspaceRoots: host.resolveWorkspaceRoots,
    resolveFilePolicy: async () => adaptFilePolicyForLoop(await rt.mergedFilePolicy()),
    resolveImageDataUrl: host.resolveImageDataUrl,
    resolveModelAdapter: session => observeModelRequests(rt.store, host.resolveModelAdapter?.(session) ?? rt.modelAdapter, rt.cumulativeInputTokensBySession),
    runTurnWithRetries: chainActive || (sessionId && isCanonicalBotChat(rt.store.getSession(sessionId) ?? {}))
      ? host.runTurnWithRetries
      : (input, stream) => {
        const session = input.sessionId ? rt.store.getSession(input.sessionId) : undefined;
        const adapter = session ? host.resolveModelAdapter?.(session) ?? rt.modelAdapter : rt.modelAdapter;
        return invokeContextModel(rt, adapter, input, stream);
      },
    fitModelRequest: (input) => fitProductModelRequest(rt, input),
    resolveTurnTools: host.resolveTurnTools,
    resolveRunProfile: host.resolveRunProfile,
    evaluateGoalGate: host.evaluateGoalGate,
    beforeModelTurn: host.beforeModelTurn,
    chooseRecovery: host.chooseRecovery,
    runLifecycleHook: host.runLifecycleHook,
    handleTurnCompletion: (session, agent) =>
      host.handleTurnCompletion(session, { id: agent.id }, host.resolveTask?.(session)),
    injectRecoveryCoach: ({ session, agent, trigger, reason }) =>
      host.injectEvolvingCoachBeforeRecovery(session, { id: agent.id }, trigger, reason),
    onSessionOutcome: (input) => {
      try {
        host.runCaseGovernance();
      } catch {
        /* fail-soft */
      }
      try {
        host.scheduleBackgroundCaseReview(input);
      } catch {
        /* fail-soft */
      }
    },
    waitSteeringChildrenIdle: host.waitSteeringChildrenIdle,
    ingestMailbox: host.ingestMailbox,
    autoClaimTask: host.autoClaimTask,
    applyFoldBudget: (session, folded) => host.applyOptionalFoldBudget(session, folded),
    recordToolUse: (input) => {
      toolIterations.add(input.turn);
      host.recordToolUse?.(input);
    },
    noteGoalWaitingUser: host.noteGoalWaitingUser,
    shouldLatchBeforeTools: host.shouldLatchBeforeTools,
    applyAutoFork: host.applyAutoFork,
    latestClosedCheckpoint: host.latestClosedCheckpoint,
    autoCompact: (context, opts) => host.autoCompact(context, opts),
    prepareMessagesForModel: (session, messages) => host.prepareMessagesForModel(session, messages),
    checkToolApprovals: async (toolCalls, context, session, extras) => {
      const decision = checkToolApprovalsForLoop(
        toolLoopDepsFrom(rt),
        toolCalls as Parameters<typeof checkToolApprovalsForLoop>[1],
        context,
        extras?.filePolicy,
        session,
        extras?.turnTools,
        rt.envApprovalPolicy,
        extras?.closedByGate
      );
      if (decision !== 'proceed') return decision;
      return jevToolGateForCalls(
        rt.store,
        session.id,
        toolCalls,
        extras?.closedByGate,
        extras?.settledApprovalIds
      );
    },
    stepTx: host.stepTx,
    vault: {
      resolveNamed(refs) {
        return getBoundSecretVault()?.resolveNamed(refs as string[]) ?? {};
      },
      runWithSecretRefs: (values, fn) => runWithSecretRefs(values, fn)
    },
    parseSecretRefs: (metadata) => parseSecretRefs(metadata),
    otel: {
      exportSpan(sessionId, name, attrs) {
        void maybeExportOtelSpan(process.env, rt.stateDir, sessionId, name, attrs ?? {});
      }
    },
    cbom: toolDeps.checkCapabilityPin
      ? {
          checkPin: (toolName, schema) => toolDeps.checkCapabilityPin!(toolName, schema)
        }
      : undefined,
    redactSecrets: (content) => redactToolContent(content, process.env),
    // Product execution archives the complete, redacted result before any
    // preview truncation, and returns its real artifact handle to the model.
    executeToolCalls: host.executeToolCalls,
    processToolResults: host.processToolResults,
    resolveWorkspacePath: (context, rel) => resolveWorkspacePath(context, rel),
    getImageAsset: (id) => rt.store.getImageAsset(id),
    runToolLifecycleHook: async (input) => {
      const r = await runLifecycleHook(process.env, {
        phase: input.phase,
        sessionId: input.sessionId,
        tool: input.tool,
        input: input.input,
        ok: input.ok,
        content: input.content
      });
      return {
        permissionDecision: lifecycleBlocks(r)
          ? 'block'
          : r.permissionDecision === 'ask'
            ? 'ask'
            : r.permissionDecision === 'allow'
              ? 'proceed'
              : undefined,
        message: r.message,
        systemMessage: r.systemMessage,
        input: r.input ?? r.updatedInput
      };
    },
    runAfterToolExtension: toolDeps.runAfterToolExtension
  };
}

function recordJevAchievement(rt: L5Bindable, session: SessionRecord, reason: string, turnsUsed: number): void {
        const achievedGoal = tryGoalStore(rt.store)?.findLatestBySession(session.id);
        void rt.emitTrace(session.id, {
          kind: 'goal_eval',
          payload: attachGoalText({
            met: true,
            reason: reason,
            source: 'jev-route',
            decision: 'achieved',
            turnsUsed: turnsUsed
          }, {
            goal: resolveGoalCondition(session.metadata) ?? achievedGoal?.condition,
            title: achievedGoal?.spec.goal
          })
        });
}

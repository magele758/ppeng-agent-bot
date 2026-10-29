/**
 * L8: Turn kernel — one session run (prepare → model → recovery → tools).
 * Pure business logic; all I/O goes through TurnKernelHost.
 */

import { createId } from '../helpers.js';
import { NotFoundError } from '../errors.js';
import { ReasoningSpinWatchdog, RepetitionLoopAbortError } from '../streaming/index.js';
import { recoveryPolicyEnabled, SessionLoopGuard } from '../recovery/session-loop-guard.js';
import { applyRepeatGuard, loopGuardStopReason, modelIdentity } from '../recovery/repeat-guard.js';
import {
  AdvisoryGrace,
  advisoryGraceBudget,
  advisoryGraceEnabled,
} from '../recovery/advisory-grace.js';
import { AdvisoryQueue } from '../recovery/advisory-queue.js';
import {
  formatRiskAdvisory,
  RiskEngine,
  riskEngineConfigFromEnv,
  riskEngineEnabled,
} from '../recovery/risk-engine.js';
import {
  decideAutoFork,
  isAutoForkUsed,
} from '../recovery/auto-fork.js';
import { recoverFromModelBehavior } from '../recovery/model-behavior-recovery.js';
import { ensureFoldToolCallsPaired } from '../recovery/pair-unmatched-tool-calls.js';
import { decideHitlLatch } from '../approval/hitl-latch.js';
import { correctWrongStopSignal } from '../model/correct-stop-reason.js';
import {
  createTurnRecoveryState,
  decideTurnRecovery,
  discardedAssistant,
  noteCriticalHit,
  toolCallParts,
} from './turn-recovery.js';
import {
  mergeOutcomeMetadata,
  runOutcomeFromEnd,
  type RunOutcome,
  type RunOutcomeRewind,
} from '../session/run-outcome.js';
import {
  createWaitingApprovalInterrupt,
  decideInterruptResume,
  mergeInterruptMetadata,
  unmatchedToolCallsFromFold,
  selectExecutableToolCalls,
  type RunInterruptState,
} from '../session/interrupt.js';
import { claimAndApplyInbox } from '../session/apply-claimed-inbox.js';
import { decideRewindTail, latestCheckpoint } from '../session/checkpoint.js';
import { clampFoldToVisible } from '../session/fold-budget.js';
import { DEFAULT_MICRO_COMPACT_CONFIG, microCompactMessages } from '../session/micro-compact.js';
import { resultsToPersist, toolWaveHeldForApproval } from '../runtime/tool-loop.js';
import { resolveHistoryTokenBudget } from '../session/session-budget.js';
import { estimateUsageCostUsd, mergeCostUsd } from '../model/token-cost.js';
import { mergeUsage, splitCumulativePromptTokens } from '../model/usage.js';
import {
  resolveLoopConfig,
  resolveTurnCap,
  type LoopConfig,
} from './config.js';
import { promoteAssistantReasoning } from '../model/promote-reasoning.js';
import { defaultPrepareView } from './default-view.js';
import type { KernelHookListener, KernelHookRegistry } from './hooks.js';
import { prepareTurnInput } from './prepare-turn-input.js';
import { createKernelStartupTrace, emitKernelReady, timeKernelPhase, timeOptionalKernelPhase, type KernelStartupTrace } from './startup-phase.js';
import {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  type SteerDrainClaimStore,
  type SteerDrainPolicy,
} from '../session/steer-drain.js';
import {
  closeOpenToolWave,
} from '../session/tool-wave-close.js';
import { rollbackReasonOf } from '../session/step-tx.js';
import { applyRunProfileToTools } from '../runtime/run-profile.js';
import { defaultWorkspaceRoots } from '../workspace/default-roots.js';
import type {
  AgentSpec,
  MessagePart,
  ModelStreamChunk,
  ModelTurnResult,
  RunContext,
  SessionMessage,
  SessionRecord,
  TokenUsage,
} from '../types.js';
import type {
  AgentStepEvent,
  CheckToolApprovalsExtras,
  KernelStepInfo,
  TurnKernelHost,
} from './host.js';

// ============================================================================
// Latch interface — minimal subset for the kernel
// ============================================================================

export interface AgentLoopLatch {
  emit(event: AgentStepEvent): Promise<void>;
}

// ============================================================================
// Options
// ============================================================================

export interface TurnKernelOptions {
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
  latch?: AgentLoopLatch;
  /** Tool-launch steer drain policy; falls back to session metadata then KV. */
  steerDrainPolicy?: SteerDrainPolicy;
  /** Loop knobs. Overrides host.loopConfig. Kernel does not read process.env. */
  config?: LoopConfig;
  /** Product-facing event subscription (in addition to latch.emit). */
  hooks?: KernelHookRegistry;
  onEvent?: KernelHookListener;
}

// ============================================================================
// Internal helpers
// ============================================================================

function textPart(text: string): MessagePart {
  return { type: 'text', text };
}

function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('exceeds token limit') ||
    msg.includes('prompt is too long')
  );
}

function composePromptCacheKey(
  parts: Array<string | number | undefined>
): string | undefined {
  const bits = parts
    .map((p) => (p == null || p === '' ? undefined : String(p)))
    .filter((p): p is string => Boolean(p));
  return bits.length > 0 ? bits.join(':') : undefined;
}

function isLastAnswerTurn(turn: number, maxTurns: number, force: boolean): boolean {
  return force && Number.isFinite(maxTurns) && turn === maxTurns - 1;
}

type KernelToolCall = Extract<MessagePart, { type: 'tool_call' }>;

function sessionParkedForApproval<T extends { id: string; status: string }>(
  store: { updateSession(id: string, patch: { status: 'waiting_approval' }): T },
  session: T
): T {
  if (session.status === 'waiting_approval') return session;
  return store.updateSession(session.id, { status: 'waiting_approval' });
}

function parkResumedApproval(
  host: TurnKernelHost,
  sid: string,
  remaining: readonly { toolCallId: string }[],
  writerRunId: string,
  interrupt: RunInterruptState
): SessionRecord {
  const approvalIds = host.store
    .listApprovals({ status: 'pending' })
    .filter((approval) => approval.sessionId === sid)
    .map((approval) => approval.id);
  const nextInterrupt = createWaitingApprovalInterrupt({
    toolCallIds: remaining.map((call) => call.toolCallId),
    approvalIds,
    writerRunId,
    executedToolCallIds: interrupt.executedToolCallIds,
  });
  const current = host.store.getSession(sid) as SessionRecord;
  return host.store.updateSession(sid, {
    status: 'waiting_approval',
    metadata: mergeInterruptMetadata(current.metadata ?? {}, nextInterrupt),
  });
}

async function continueResumedToolWave(input: {
  host: TurnKernelHost;
  sid: string;
  turn: number;
  sessionId: string;
  remaining: KernelToolCall[];
  context: RunContext;
  refreshedSession: SessionRecord;
  filePolicy: CheckToolApprovalsExtras['filePolicy'];
  interrupt: RunInterruptState;
  writerRunId: string;
  pickTurnTools: (
    sess: SessionRecord,
    messages: SessionMessage[],
    systemPromptChars: number,
    emptyTools: boolean
  ) => Promise<{ allowExternalAiTools: boolean; resolvedTools: TurnKernelHost['tools'] }>;
  emitStep: (ev: AgentStepEvent) => Promise<void>;
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
}): Promise<SessionRecord | undefined> {
  const folded = input.host.store.foldMessages(input.sid);
  const picked = await input.pickTurnTools(input.context.session, folded, 0, false);
  const closedByGate = { reported: false, ids: [] as string[] };
  const gate = await input.host.checkToolApprovals?.(
    input.remaining,
    input.context,
    input.refreshedSession,
    {
      filePolicy: input.filePolicy,
      turnTools: picked.resolvedTools,
      closedByGate,
      settledApprovalIds: input.interrupt.approvalIds,
    }
  );
  if (gate === 'waiting') {
    return parkResumedApproval(input.host, input.sid, input.remaining, input.writerRunId, input.interrupt);
  }
  if (gate === 'skip') return undefined;
  const allowIds = input.interrupt.toolCallIds.filter(
    (id) => !input.interrupt.executedToolCallIds.includes(id)
  );
  const executable = selectExecutableToolCalls(input.remaining, closedByGate, () =>
    unmatchedToolCallsFromFold(input.host.store.foldMessages(input.sid), allowIds)
  );
  if (executable.length === 0) return undefined;
  const results = await input.host.executeToolCalls(
    executable,
    input.context,
    picked.allowExternalAiTools,
    input.sessionId,
    picked.resolvedTools
  );
  input.host.processToolResults(
    resultsToPersist(results),
    executable,
    input.context.session,
    undefined,
    input.sessionId,
    input.onModelStreamChunk
  );
  if (toolWaveHeldForApproval(results)) {
    return parkResumedApproval(input.host, input.sid, input.remaining, input.writerRunId, input.interrupt);
  }
  results.forEach((result) => {
    input.host.recordToolUse?.({
      name: result.name,
      sessionId: input.sid,
      turn: input.turn,
      ok: result.ok,
    });
  });
  await input.emitStep({
    type: 'tools_done',
    results: results.map((result) => ({ ok: result.ok, content: result.content, name: result.name })),
  });
  return undefined;
}

// ============================================================================
// Main kernel
// ============================================================================

function sessionForTurn(host: TurnKernelHost, sessionId: string, fallback: SessionRecord): SessionRecord {
  return host.store.getSession(sessionId) ?? fallback;
}

interface KernelExecution {
  session: SessionRecord;
  agent: AgentSpec;
  controller: AbortController;
  writerRunId: string;
  resumeFromInterrupt?: RunInterruptState;
}

// Keep admission and scope ownership separate from the existing turn implementation.
// The public import remains runSessionKernel; hosts do not construct KernelExecution.
export { runSessionKernelWithWriterScope as runSessionKernel };

async function runSessionKernelWithWriterScope(
  host: TurnKernelHost,
  sessionId: string,
  options?: TurnKernelOptions
): Promise<SessionRecord> {
  const session: SessionRecord = host.store.getSession(sessionId)!;
  if (!session) {
    throw new NotFoundError(`Session not found: ${sessionId}`);
  }

  // Resume-from-interrupt check
  const pendingApprovalIds = host.store
    .listApprovals({ status: 'pending' })
    .filter((a) => a.sessionId === sessionId)
    .map((a) => a.id);
  const resumeDecision = decideInterruptResume({ session, pendingApprovalIds });

  const existingController = host.sessionAbortControllers?.get(sessionId);
  const controller = existingController ?? new AbortController();
  host.sessionAbortControllers?.set(sessionId, controller);
  const sid = session.id;
  const writerRunId = createId('run');
  const emitTrace: TurnKernelHost['emitTrace'] = (id, event) => {
    try { host.emitTrace(id, event); }
    catch { /* tracing must not fail the turn */ }
  };
  const tracedHost: TurnKernelHost = { ...host, emitTrace };
  const startup = createKernelStartupTrace(sid, emitTrace);
  try {
    await timeKernelPhase(startup, 'writer_claim', () => {
      host.store.claimWriter(sessionId, writerRunId);
    });
  } catch (error) {
    emitKernelReady(startup);
    if (!existingController && host.sessionAbortControllers?.get(sessionId) === controller) host.sessionAbortControllers.delete(sessionId);
    throw error;
  }
  const settle = async (): Promise<SessionRecord> => {
    try {
      // Admission may follow another executor completing or replacing this pause.
      // Recompute from persisted state while writes are bound to our new claim.
      const admittedSession = host.store.getSession(sid);
      if (!admittedSession) {
        emitKernelReady(startup);
        throw new NotFoundError(`Session not found: ${sid}`);
      }
      const decision = decideInterruptResume({
        session: admittedSession,
        pendingApprovalIds: host.store.listApprovals({ status: 'pending' }).filter(a => a.sessionId === sid).map(a => a.id)
      });
      if (decision.action === 'yield_waiting') {
        const parked = sessionParkedForApproval(host.store, admittedSession);
        await options?.latch?.emit({ type: 'waiting_approval', approvalIds: decision.interrupt.approvalIds });
        emitKernelReady(startup);
        return parked;
      }
      if (resumeDecision.action !== 'none' && decision.action === 'none') {
        emitKernelReady(startup);
        return admittedSession;
      }
      const agent = host.store.getAgent(admittedSession.agentId);
      if (!agent) {
        emitKernelReady(startup);
        throw new NotFoundError(`Agent not found: ${admittedSession.agentId}`);
      }
      const resumeFromInterrupt = decision.action === 'resume_tools' ? decision.interrupt : undefined;
      return await runSessionKernel(tracedHost, sessionId, { session: admittedSession, agent, controller, writerRunId, resumeFromInterrupt }, options, startup);
    }
    finally {
      if (host.sessionAbortControllers?.get(sid) === controller) host.sessionAbortControllers.delete(sid);
      host.store.releaseWriter(sid, writerRunId);
    }
  };
  return host.store.runWithWriter ? host.store.runWithWriter(sid, writerRunId, settle) : settle();
}


const KERNEL_TURN: unique symbol = Symbol('kernel-turn');
const KERNEL_TURN_STOPS = new Set<string>(['continue', 'break', 'return']);
type KernelTurnFlow = { [KERNEL_TURN]: 'continue' | 'break' | 'return'; value?: unknown };

function kernelTurnSignal(stop: 'continue' | 'break' | 'return', value?: unknown): KernelTurnFlow {
  return { [KERNEL_TURN]: stop, value };
}

function kernelTurnStop(flow: unknown): 'continue' | 'break' | 'return' | undefined {
  const stop = typeof flow === 'object' && flow ? (flow as KernelTurnFlow)[KERNEL_TURN] : undefined;
  return typeof stop === 'string' && KERNEL_TURN_STOPS.has(stop) ? stop as 'continue' | 'break' | 'return' : undefined;
}

async function runSessionKernel(
  host: TurnKernelHost,
  sessionId: string,
  execution: KernelExecution,
  options: TurnKernelOptions | undefined,
  startup: KernelStartupTrace
): Promise<SessionRecord> {
  let { session, resumeFromInterrupt } = execution;
  const { agent, controller, writerRunId } = execution;
  const signal = controller.signal;
  const sid = session.id;
  const loopConfig = resolveLoopConfig(
    { maxTurns: host.maxTurnsPerRun, maxContextTokens: host.maxContextTokens },
    host.loopConfig,
    options?.config
  );
  const maxTurns = resolveTurnCap(loopConfig.maxTurns ?? host.maxTurnsPerRun);
  const stopAt = new Set(loopConfig.stopAtToolNames);
  const usageBySession =
    host.cumulativeInputTokensBySession ??
    new Map<string, { cumulative: number; sticky: boolean }>();

  const emitStep = async (ev: AgentStepEvent) => {
    if (options?.latch) await options.latch.emit(ev);
    if (options?.hooks) await options.hooks.onEvent(ev);
    if (options?.onEvent) await options.onEvent(ev);
  };

  try {
    await host.stepTx?.beginRun?.({ sessionId, runId: writerRunId });
  } catch {
    /* fail-soft */
  }

  const persistOutcome = (
    record: SessionRecord,
    reason: string,
    rewind?: RunOutcomeRewind
  ): { record: SessionRecord; outcome: RunOutcome } => {
    const outcome = runOutcomeFromEnd({ reason, sessionStatus: record.status, rewind });
    const next = host.store.updateSession(record.id, {
      metadata: mergeOutcomeMetadata(record.metadata ?? {}, outcome),
    });
    return { record: next, outcome };
  };

  const endRunTx = async (reason: string) => {
    try {
      await host.stepTx?.endRun?.({ sessionId: sid, runId: writerRunId, reason });
    } catch {
      /* fail-soft */
    }
  };

  const rewindUncommitted = async (reason: string): Promise<RunOutcomeRewind | undefined> => {
    try {
      await host.stepTx?.rollbackUncommitted?.(reason);
    } catch {
      /* fail-soft */
    }
    try {
      const current = host.store.getSession(sid);
      const folded = host.store.foldMessages(sid);
      const currentSeq = folded[folded.length - 1]?.seq ?? 0;
      const checkpoint =
        host.latestClosedCheckpoint?.(sid) ?? latestCheckpoint(current?.metadata);
      const decision = decideRewindTail({
        currentSeq,
        checkpointSeq: checkpoint?.seq,
      });
      if (!decision.shouldRewind || !host.store.hideRange) return undefined;
      host.store.hideRange(sid, decision.fromSeq, decision.toSeq, {
        expectedWriterRunId: writerRunId,
      });
      return {
        toSeq: checkpoint?.seq ?? decision.fromSeq - 1,
        shadowedCount: decision.toSeq - decision.fromSeq + 1,
        reason,
      };
    } catch {
      return undefined;
    }
  };

  const finishFailed = async (record: SessionRecord, reason: string) => {
    emitKernelReady(startup);
    const rewind = await rewindUncommitted(reason);
    await endRunTx(reason);
    const current = host.store.getSession(sid) ?? record;
    const { record: next, outcome } = persistOutcome(current, reason, rewind);
    void host.emitTrace(next.id, {
      kind: 'turn_end',
      data: { terminal: true, reason, outcome },
    });
    if (reason === 'abort') {
      await emitStep({ type: 'abort' });
    }
    await emitStep({ type: 'ended', reason, outcome });
    return next;
  };

  const finishEnded = async (record: SessionRecord, reason: string) => {
    emitKernelReady(startup);
    await endRunTx(reason);
    const { record: next, outcome } = persistOutcome(record, reason);
    void host.emitTrace(next.id, {
      kind: 'turn_end',
      data: { terminal: true, reason, outcome },
    });
    await emitStep({ type: 'ended', reason, outcome });
    return next;
  };

  const adapterOf = (sess: SessionRecord) =>
    host.resolveModelAdapter?.(sess) ?? host.modelAdapter;

  const closeWaveIfOpen = () => {
    try {
      closeOpenToolWave(host.store, sid, 'interrupted');
    } catch {
      /* best-effort */
    }
  };

  let stepCursor = 0;
  const stepInfo = (turn: number, kind: KernelStepInfo['kind']): KernelStepInfo => {
    stepCursor += 1;
    return { turn, step: stepCursor, kind, sessionId: sid };
  };
  const rollbackOpenStep = async (reason: string) => {
    try {
      await host.stepTx?.rollbackUncommitted?.(reason);
    } catch {
      /* fail-soft */
    }
  };

  const tryAutoFork = async (
    trigger: 'repetition-aborted' | 'deadloop-exhausted'
  ): Promise<boolean> => {
    if (!host.applyAutoFork) return false;
    try {
      const current = host.store.getSession(sid);
      if (!current) return false;
      const folded = host.store.foldMessages(sid);
      const currentSeq = folded[folded.length - 1]?.seq ?? 0;
      const checkpoint =
        host.latestClosedCheckpoint?.(sid) ?? latestCheckpoint(current.metadata);
      const decision = decideAutoFork({
        trigger,
        alreadyUsed: isAutoForkUsed(current.metadata),
        checkpoint: checkpoint ? { seq: checkpoint.seq } : undefined,
        currentSeq,
      });
      if (!decision.shouldFork || !decision.guidance) return false;
      const applied = await host.applyAutoFork({
        session: current,
        trigger,
        checkpointSeq: checkpoint?.seq,
        guidance: decision.guidance,
      });
      if (applied && applied.applied === false) return false;
      host.mergeSessionMetadata(sid, { autoForkUsed: true });
      return true;
    } catch {
      return false;
    }
  };

  // Thresholds come from the host-provided env bag (RAW_AGENT_RECOVERY_* /
  // RAW_AGENT_RISK_*); an empty bag yields the documented defaults.
  const env = host.env ?? {};
  const loopGuard =
    loopConfig.recoveryEnabled && recoveryPolicyEnabled(env) ? new SessionLoopGuard(env) : null;
  // Budget 0 makes grace a pass-through (abort stays abort), i.e. "disabled".
  const advisoryGrace = new AdvisoryGrace(
    loopGuard && advisoryGraceEnabled(env) ? advisoryGraceBudget(env) : 0
  );
  const advisoryQueue = new AdvisoryQueue();
  const riskEngine = riskEngineEnabled(env) ? new RiskEngine(riskEngineConfigFromEnv(env)) : null;
  const spinWatchdog = loopConfig.spinWatchdog
    ? new ReasoningSpinWatchdog({
        maxConsecutiveNoProgress: loopConfig.spinWatchdogMaxConsecutive,
      })
    : null;
  const recoveryState = createTurnRecoveryState();
  const progressGuard = loopGuard ?? new SessionLoopGuard(env);

  const packTurn = async (input: {
    workspaceRoot?: string;
    skipCompact?: boolean;
    skipAppendix?: boolean;
  }) => {
    const current = host.store.getSession(sid);
    const profile = current ? host.resolveRunProfile?.(current) : undefined;
    const skipMemory = Boolean(input.skipAppendix || profile?.persistentMemory === 'off');
    return prepareTurnInput(sid, {
      store: host.store,
      autoCompact: async () => {
        if (input.skipCompact || !loopConfig.compactEveryTurn) return;
        const sess = host.store.getSession(sid);
        if (!sess) return;
        const compacted = await host.autoCompact(
          {
            repoRoot: host.repoRoot,
            stateDir: host.stateDir,
            session: sess,
            agent,
            workspaceRoot: input.workspaceRoot ?? host.repoRoot,
            workspaceRoots: defaultWorkspaceRoots(input.workspaceRoot, host.repoRoot),
          },
          {}
        );
        if (compacted.replaced) {
          await emitStep({ type: 'compacted', replaced: compacted.replaced });
        }
      },
      claimNextStep: () =>
        typeof host.store.claimInbox === 'function' ? host.store.claimInbox(sid, 'next-step') : [],
      prepareView: (sess, msgs) =>
        host.prepareMessagesForModel
          ? host.prepareMessagesForModel(sess, msgs)
          : Promise.resolve(
              defaultPrepareView(msgs, { refusalPreservation: loopConfig.refusalPreservation })
            ),
      buildAppendix: async (sess, pack) => {
        if (skipMemory) return '';
        return host.promptBuilder.buildMemoryAppendix(
          {
            sessionId: sid,
            agent,
            session: sess,
            workspaceRoot: input.workspaceRoot ?? host.repoRoot,
            repoRoot: host.repoRoot,
          },
          { query: pack?.query, stateDir: host.stateDir }
        );
      },
      applyFoldBudget: (sess, foldedMsgs) => {
        if (host.applyFoldBudget) return host.applyFoldBudget(sess, foldedMsgs);
        if (!loopConfig.foldBudgetClamp) return foldedMsgs;
        const compacted = microCompactMessages(foldedMsgs, DEFAULT_MICRO_COMPACT_CONFIG).messages;
        const tokenBudget = resolveHistoryTokenBudget(
          'RAW_AGENT_COMPACT_TOKEN_THRESHOLD',
          { maxContextTokens: loopConfig.maxContextTokens ?? host.maxContextTokens },
          env
        );
        return clampFoldToVisible(compacted, {
          maxVisible: loopConfig.maxVisibleMessages,
          tokenBudget,
        });
      },
      readWorkingLogTail:
        skipMemory || !host.readWorkingLogAppendix
          ? undefined
          : (id) => host.readWorkingLogAppendix!(id),
      emitTrace: (id, event) => host.emitTrace?.(id, event),
    });
  };

  const pickTurnTools = async (
    sess: SessionRecord,
    messages: SessionMessage[],
    systemPromptChars: number,
    emptyTools: boolean
  ) => {
    const turnProfile = host.resolveRunProfile?.(sess);
    const turnTools = await Promise.resolve(
      host.resolveTurnTools?.({
        session: sess,
        agent,
        messages,
        systemPromptChars,
      })
    );
    if (turnTools?.metadataPatch) {
      host.mergeSessionMetadata(sid, turnTools.metadataPatch);
    }
    if (turnTools?.trace) {
      void host.emitTrace(sid, {
        kind: turnTools.trace.kind,
        data: turnTools.trace.payload,
      });
    }
    const allowExternalAiTools = turnTools?.allowExternalAiTools ?? false;
    const selectedTools = emptyTools ? [] : (turnTools?.tools ?? host.tools);
    const assembledForProfile = turnTools?.tools ? selectedTools : host.tools;
    const resolvedTools = emptyTools
      ? []
      : turnProfile
        ? applyRunProfileToTools(selectedTools, turnProfile, assembledForProfile)
        : selectedTools;
    return { allowExternalAiTools, selectedTools, resolvedTools, turnTools, turnProfile };
  };

  const runModelTurn: TurnKernelHost['runTurnWithRetries'] = async (turnInput, onStream) => {
    const fitted = host.fitModelRequest
      ? await timeKernelPhase(startup, 'fit_model_request', () => host.fitModelRequest!(turnInput))
      : turnInput;
    if (!host.fitModelRequest) await timeOptionalKernelPhase(startup, 'fit_model_request', undefined);
    emitKernelReady(startup);
    return host.runTurnWithRetries(fitted, onStream);
  };

  const maybeChooseRecovery = async (
    situation: string,
    options: ReadonlyArray<{ id: string; label: string }>,
    defaultId: string
  ): Promise<string> => {
    if (!host.chooseRecovery || options.length < 2) return defaultId;
    const picked = await host.chooseRecovery({ situation, options, defaultId });
    if (typeof picked === 'string' && options.some((o) => o.id === picked)) return picked;
    return defaultId;
  };

  try {
    await timeOptionalKernelPhase(startup, 'ensure_mcp', host.ensureMcpLoaded ? () => host.ensureMcpLoaded!(sid) : undefined);
    const filePolicy = await timeOptionalKernelPhase(startup, 'resolve_file_policy', host.resolveFilePolicy ? () => host.resolveFilePolicy!() : undefined);
    session = host.store.updateSession(session.id, { status: 'running' });
    await timeOptionalKernelPhase(startup, 'ingest_mailbox', host.ingestMailbox ? () => host.ingestMailbox!(session) : undefined);
    await timeOptionalKernelPhase(startup, 'auto_claim_task', host.autoClaimTask ? () => host.autoClaimTask!(session) : undefined);
    await timeKernelPhase(startup, 'claim_next_run', () => {
      claimAndApplyInbox(host.store, sid, 'next-run', { expectedWriterRunId: writerRunId });
    });

    {
const kernelFinished = await (async () => {
for (let turn = 0; turn < maxTurns; turn += 1) {
let refreshedSession: any;
let task: any;
let workspaceRoot: any;
let resolvedRoots: any;
let workspaceRoots: any;
let context: any;
let packed: any;
let visibleMessages: any;
let rawVisible: any;
let promptCtx: any;
let drainedAdvisory: any;
let systemPrompt: any;
let beforeHook: any;
let lastTurn: any;
let picked: any;
let allowExternalAiTools: any;
let resolvedTools: any;
let turnTools: any;
let promptCacheKey: any;
let turnInput: any;
let preTurn: any;
let turnResult: any;
let promoted: any;
let stopFix: any;
let turnCostUsd: any;
let turnCostModel: any;
let recovery: any;
let spinReason: any;
let pendingRecoveryAdvisory: any;
let rawRep: any;
let repSession: any;
let repAdapter: any;
let rep: any;
let graceOut: any;
let modelStep: any;
let assistantMessage: any;
let rawToolCalls: any;
let toolCalls: any;
let closedByGate: any;
let approvalResult: any;
let hostLatch: any;
let latch: any;
let parkForApproval: any;
let drainPolicy: any;
let executable: any;
let toolsStep: any;
let results: any;
let progressDecision: any;
let toolRep: any;
let live: any;
let adapter: any;
let guarded: any;
let toolRepDecision: any;
let toolGraceOut: any;
const kernelTurnFlow = await (async () => {
const kernelSteps: Array<() => Promise<unknown>> = [
async () => {
async function __gate146() {
let startHook: any;
async function __gate144() {
startHook = await timeOptionalKernelPhase(
          startup,
          'session_start_hook',
          host.runLifecycleHook
            ? () => host.runLifecycleHook!({
                phase: 'session_start',
                sessionId: sid,
                agentId: agent.id,
                turn: 0,
              })
            : undefined
        );
if (startHook?.block) {
          const msg = startHook.message ?? startHook.systemMessage ?? 'blocked by session_start hook';
          host.store.appendMessage(sid, 'system', [textPart(msg)]);
          emitKernelReady(startup);
          return kernelTurnSignal('return', await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'session_start_blocked'));
        }
return undefined;
}
function __gate145() {
if (startHook?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(startHook.systemMessage)]);
        }
return undefined;
}
const __gateSignal = await (await __gate144() ?? __gate145());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
async function __gate147() {
if (signal.aborted) {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return kernelTurnSignal('return', await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort'));
      }
refreshedSession = host.store.getSession(session.id) as SessionRecord;
task = host.resolveTask?.(refreshedSession) ??
        (refreshedSession.taskId ? host.store.getTask?.(refreshedSession.taskId) : undefined);
workspaceRoot = await timeOptionalKernelPhase(
        startup,
        'ensure_workspace',
        host.ensureWorkspaceRoot ? () => host.ensureWorkspaceRoot!(refreshedSession, task) : undefined
      );
return undefined;
}
async function __gate148() {
resolvedRoots = await timeOptionalKernelPhase(
        startup,
        'resolve_workspace',
        host.resolveWorkspaceRoots ? () => host.resolveWorkspaceRoots!(refreshedSession) : undefined
      );
workspaceRoots = resolvedRoots ?? defaultWorkspaceRoots(workspaceRoot, host.repoRoot);
context = {
        repoRoot: host.repoRoot,
        stateDir: host.stateDir,
        session: refreshedSession,
        agent,
        workspaceRoot: workspaceRoot ?? host.repoRoot,
        workspaceRoots,
        abortSignal: signal,
      };
return undefined;
}
async function __gate149() {
if (resumeFromInterrupt) {
        const interrupt = resumeFromInterrupt;
        resumeFromInterrupt = undefined;

        claimAndApplyInbox(host.store, sid, 'next-step', { expectedWriterRunId: writerRunId });

        const remaining = unmatchedToolCallsFromFold(
          host.store.foldMessages(sid),
          interrupt.toolCallIds.filter((id) => !interrupt.executedToolCallIds.includes(id))
        );

        if (remaining.length > 0) {
          const parked = await continueResumedToolWave({
            host,
            sid,
            turn,
            sessionId,
            remaining,
            context,
            refreshedSession,
            filePolicy,
            interrupt,
            writerRunId,
            pickTurnTools,
            emitStep,
            onModelStreamChunk: options?.onModelStreamChunk,
          });
          if (parked) {
            emitKernelReady(startup);
            return kernelTurnSignal('return', parked);
          }
        }

        const afterResume = host.store.getSession(sid);
        host.store.updateSession(sid, {
          metadata: mergeInterruptMetadata(afterResume?.metadata ?? {}, null),
        });
        return kernelTurnSignal('continue');
      }
ensureFoldToolCallsPaired({
        foldMessages: () => host.store.foldMessages(sid),
        appendMessage: (role, parts) => host.store.appendMessage(sid, role, parts),
      });
packed = await timeKernelPhase(startup, 'pack_turn', () => packTurn({ workspaceRoot }));
context = { ...context, session: packed.session };
visibleMessages = packed.messages;
rawVisible = packed.viewMessages;
await emitStep({
        type: 'turn_prepared',
        messageCount: visibleMessages.length,
        messages: visibleMessages,
        foldSeqs: packed.foldSeqs,
      });
return undefined;
}
async function __gate150() {
promptCtx = {
        sessionId: sid,
        agent,
        session: context.session,
        workspaceRoot: workspaceRoot ?? host.repoRoot,
        repoRoot: host.repoRoot,
      };
drainedAdvisory = advisoryQueue.drainCombined();
if (drainedAdvisory) {
        host.store.appendMessage(sid, 'system', [textPart(drainedAdvisory)]);
      }
systemPrompt = await timeKernelPhase(startup, 'build_system_prompt', () =>
        host.promptBuilder.buildSystemPrompt(promptCtx, rawVisible)
      );
if (turn === 0) {
const __gateSignal = await __gate146();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
async function __gate151() {
beforeHook = await timeOptionalKernelPhase(
        startup,
        'before_turn_hook',
        host.runLifecycleHook
          ? () => host.runLifecycleHook!({
              phase: 'before_turn',
              sessionId: sid,
              agentId: agent.id,
              turn,
            })
          : undefined
      );
if (beforeHook?.block) {
        const msg = beforeHook.message ?? beforeHook.systemMessage ?? 'blocked by before_turn hook';
        host.store.appendMessage(sid, 'system', [textPart(msg)]);
        return kernelTurnSignal('return', await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'before_turn_blocked'));
      }
return undefined;
}
async function __gate152() {
if (beforeHook?.systemMessage) {
        host.store.appendMessage(sid, 'system', [textPart(beforeHook.systemMessage)]);
      }
lastTurn = isLastAnswerTurn(turn, maxTurns, loopConfig.forceAnswerOnLastTurn);
picked = await timeKernelPhase(startup, 'pick_turn_tools', () => pickTurnTools(
        context.session,
        visibleMessages,
        systemPrompt.length,
        lastTurn
      ));
allowExternalAiTools = picked.allowExternalAiTools;
resolvedTools = picked.resolvedTools;
turnTools = picked.turnTools;
promptCacheKey = composePromptCacheKey([
        turnTools?.promptCacheKey,
        host.promptCacheEpoch,
        loopConfig.promptCacheBustKey,
      ]);
void host.emitTrace(sid, {
        kind: 'turn_start',
        data: {
          turn,
          adapter: adapterOf(context.session).name,
          ...(promptCacheKey ? { promptCacheKey } : {}),
        },
      });
return undefined;
}
async function __gate153() {
turnInput = {
        agent,
        systemPrompt: lastTurn ? `${systemPrompt}\n\n${loopConfig.lastTurnNudge}` : systemPrompt,
        messages: visibleMessages,
        tools: resolvedTools,
        signal,
        sessionId: sid,
        resolveImageDataUrl: host.resolveImageDataUrl
          ? (assetId: string) => host.resolveImageDataUrl!(assetId, context.session.id)
          : undefined,
        ...(promptCacheKey ? { promptCacheKey } : {}),
      };
preTurn = await timeOptionalKernelPhase(
        startup,
        'before_model',
        host.beforeModelTurn
          ? () => host.beforeModelTurn!({
              session: context.session,
              messages: visibleMessages,
              hasPendingToolCalls: false,
            })
          : undefined
      );
return undefined;
}
async function __gateGrp154() {
const __gateSignal = await (await __gate147() ?? await __gate148() ?? await __gate149() ?? await __gate150());
if (__gateSignal) return __gateSignal;
return undefined;
}
async function __gateGrp155() {
const __gateSignal = await (await __gate151() ?? await __gate152() ?? await __gate153());
if (__gateSignal) return __gateSignal;
return undefined;
}
const __gateSignal = await (await __gateGrp154() ?? await __gateGrp155());
if (__gateSignal) return __gateSignal;
return undefined;
},
async () => {
async function __gate133() {

turnResult = await runModelTurn(turnInput, options?.onModelStreamChunk);
return undefined;
}
async function __gate140(error: any) {
async function __gate136() {
let repChoice: any;
async function __gate134() {
void host.emitTrace(sid, {
            kind: 'repetition_abort',
            data: { reason: error.reason, retry: true },
          });
repChoice = await maybeChooseRecovery(
            `repetition_abort:${error.reason}`,
            [
              { id: 'retry', label: 'Retry the model turn once with a clean stream' },
              { id: 'stop', label: 'Stop the run after repetition' },
            ],
            'retry'
          );
if (repChoice === 'stop') {
            host.store.appendMessage(sid, 'system', [
              textPart(
                `[recovery] Stopped: model output degenerated into repetition (${error.reason})`
              ),
            ]);
            if (await tryAutoFork('repetition-aborted')) return kernelTurnSignal('continue');
            return kernelTurnSignal('return', await finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            ));
          }
return undefined;
}
async function __gate135() {
try {
            turnResult = await runModelTurn(turnInput, options?.onModelStreamChunk);
          } catch (retryError) {
            const reason =
              retryError instanceof RepetitionLoopAbortError ? retryError.reason : error.reason;
            void host.emitTrace(sid, {
              kind: 'repetition_abort',
              data: { reason, retry: false },
            });
            host.store.appendMessage(sid, 'system', [
              textPart(
                `[recovery] Stopped: model output degenerated into repetition (${reason})`
              ),
            ]);
            if (await tryAutoFork('repetition-aborted')) return kernelTurnSignal('continue');
            return kernelTurnSignal('return', await finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            ));
          }
return undefined;
}
const __gateSignal = await (await __gate134() ?? await __gate135());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
async function __gate139() {
async function __gate137() {
let compacted: any;
let packedRetry: any;
void host.emitTrace(sid, {
            kind: 'model_error',
            data: {
              message: error instanceof Error ? error.message : String(error),
              overflow: true,
            },
          });
compacted = await host.autoCompact(context, { force: true });
if (compacted.replaced) {
            await emitStep({ type: 'compacted', replaced: compacted.replaced });
          }
packedRetry = loopConfig.overflowReprepare
            ? await packTurn({
                workspaceRoot,
                skipCompact: true,
                skipAppendix: loopConfig.overflowSkipAppendix,
              })
            : {
                messages: host.prepareMessagesForModel
                  ? await host.prepareMessagesForModel(
                      context.session,
                      host.store.foldMessages(sid)
                    )
                  : defaultPrepareView(host.store.foldMessages(sid), {
                      refusalPreservation: loopConfig.refusalPreservation,
                    }),
              };
turnInput = { ...turnInput, messages: packedRetry.messages };
turnResult = await runModelTurn(turnInput, options?.onModelStreamChunk);
return undefined;
}
async function __gate138() {

if (signal.aborted) {
          closeWaveIfOpen();
          await rollbackOpenStep('abort');
          return kernelTurnSignal('return', await finishFailed(
            host.store.updateSession(session.id, { status: 'failed' }),
            'abort'
          ));
        } else {
          const err = error instanceof Error ? error : new Error(String(error));
          const pending = unmatchedToolCallsFromFold(host.store.foldMessages(sid));
          const recovered = await recoverFromModelBehavior({
            error: err,
            pending: pending.map((p) => ({ toolCallId: p.toolCallId, name: p.name })),
            currentToolNames: resolvedTools.map((t: { name: string }) => t.name),
            appendResults: (results) => {
              host.store.appendMessage(
                sid,
                'tool',
                results.map((r) => ({
                  type: 'tool_result' as const,
                  toolCallId: r.toolCallId,
                  name: r.name,
                  ok: r.ok,
                  content: r.content,
                }))
              );
            },
          });
          if (recovered.recovered) {
            void host.emitTrace(sid, {
              kind: 'recovery_advisory',
              data: { reason: 'model_behavior', trigger: 'protocol_heal', count: recovered.results.length },
            });
            return kernelTurnSignal('continue');
          }
          void host.emitTrace(sid, {
            kind: 'model_error',
            data: { message: err.message },
          });
          const txReason = rollbackReasonOf({ runError: err.message });
          if (txReason) await rollbackOpenStep(txReason);
          throw error;
        }
return undefined;
}
if (isContextOverflowError(error)) {
const __gateSignal = await __gate137();
if (__gateSignal) return __gateSignal;
} else {
const __gateSignal = await __gate138();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
if (error instanceof RepetitionLoopAbortError) {
const __gateSignal = await __gate136();
if (__gateSignal) return __gateSignal;
} else {
const __gateSignal = await __gate139();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
async function __gate141() {
if (preTurn === 'skip_goal_done') emitKernelReady(startup);
if (preTurn === 'skip_goal_done') {
        host.store.appendMessage(sid, 'system', [
          textPart('[jev-pre-turn] Goal assumed met; skipping deep model turn.'),
        ]);
        if (host.waitSteeringChildrenIdle) {
          await host.waitSteeringChildrenIdle(sid);
        }
        host.onSessionOutcome?.({
          sessionId: session.id,
          agentId: agent.id,
          outcome: 'success',
          signals: { source: 'jev-pre-turn' },
        });
        return kernelTurnSignal('return', await host.handleTurnCompletion(session, agent).then((completed) =>
          finishEnded(completed, 'end')
        ));
      }
return undefined;
}
async function __gate142() {
try {
const __gateSignal = await __gate133();
if (__gateSignal) return __gateSignal;
} catch (error) {
const __gateSignal = await __gate140(error);
if (__gateSignal) return __gateSignal;
}
promoted = promoteAssistantReasoning(turnResult.assistantParts);
if (promoted.promoted) {
        turnResult = { ...turnResult, assistantParts: promoted.parts };
      }
return undefined;
}
function __gate143() {
if (lastTurn) {
        const hadCalls = turnResult.assistantParts.some((p: MessagePart) => p.type === 'tool_call');
        const withoutCalls = turnResult.assistantParts.filter((p: MessagePart) => p.type !== 'tool_call');
        const hasText = withoutCalls.some((p: MessagePart) => p.type === 'text' && p.text.trim());
        // Match chrome distill: last turn with tool calls or empty text uses fallback copy.
        // Clear finishReason so protocol recovery does not treat stripped tools as a leak.
        turnResult = {
          ...turnResult,
          stopReason: 'end',
          finishReason: 'stop',
          truncated: false,
          assistantParts: hadCalls || !hasText ? [textPart(loopConfig.lastTurnFallback)] : withoutCalls,
        };
      }
stopFix = correctWrongStopSignal({
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        toolCallCount: toolCallParts(turnResult.assistantParts).length,
      });
if (stopFix.corrected) {
        void host.emitTrace(sid, {
          kind: 'recovery_advisory',
          data: {
            reason: 'wrong_stop_signal',
            trigger: 'wrong_stop_signal',
            finishReason: turnResult.finishReason,
            stopReason: turnResult.stopReason,
          },
        });
        turnResult = { ...turnResult, stopReason: stopFix.stopReason as ModelTurnResult['stopReason'] };
      }
return undefined;
}
const __gateSignal = await (await __gate141() ?? await __gate142() ?? __gate143());
if (__gateSignal) return __gateSignal;
return undefined;
},
async () => {
async function __gate120() {
let prev: any;
let split: any;
function __gate118() {
prev = usageBySession.get(sid);
split = splitCumulativePromptTokens(
          turnResult.usage.inputTokens,
          prev?.cumulative,
          prev?.sticky ?? false
        );
usageBySession.set(sid, {
          cumulative: split.cumulativeInputTokens,
          sticky: (prev?.sticky ?? false) || split.treatedAsCumulative,
        });
return undefined;
}
function __gate119() {
if (split.treatedAsCumulative) {
          const cached = Math.min(turnResult.usage.cachedInputTokens ?? 0, split.turnInputTokens);
          turnResult = {
            ...turnResult,
            usage: {
              ...turnResult.usage,
              inputTokens: split.turnInputTokens,
              totalTokens: split.turnInputTokens + turnResult.usage.outputTokens,
              ...(cached > 0 ? { cachedInputTokens: cached } : {}),
            },
          };
          void host.emitTrace(sid, {
            kind: 'usage_cumulative_split',
            data: {
              reportedInputTokens: split.cumulativeInputTokens,
              turnInputTokens: split.turnInputTokens,
            },
          });
        }
return undefined;
}
const __gateSignal = await (__gate118() ?? __gate119());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
function __gateExpr121() { return (turnCostUsd !== undefined ? { costUsd: turnCostUsd, costModel: turnCostModel } : {}); }
function __gateExpr122() { return {
          stopReason: turnResult.stopReason,
          ...(turnResult.finishReason ? { finishReason: turnResult.finishReason } : {}),
          ...(turnResult.usage ? { usage: turnResult.usage } : {}),
          ...(turnResult.truncated ? { truncated: true } : {}),
          ...(turnResult.requestId ? { requestId: turnResult.requestId } : {}),
          ...__gateExpr121(),
        }; }
function __gateExpr123() { return {
        kind: 'turn_end',
        data: __gateExpr122(),
      }; }
function __gateExpr124() { return host.emitTrace(sid, __gateExpr123()); }
async function __gate129() {
async function __gate127() {
let current: any;
let prevTotals: any;
let prevCostUsd: any;
let merged: any;
let usageCostUsd: any;
function __gate125() {
current = host.store.getSession(session.id);
prevTotals = (current?.metadata?.usageTotals ?? undefined) as TokenUsage | undefined;
merged = mergeUsage(prevTotals, turnResult.usage);
prevCostUsd = typeof current?.metadata?.usageCostUsd === 'number'
              ? (current.metadata.usageCostUsd as number)
              : undefined;
usageCostUsd = mergeCostUsd(prevCostUsd, turnCostUsd);
return undefined;
}
function __gate126() {
if (merged) {
            host.store.updateSession(session.id, {
              metadata: {
                ...(current?.metadata ?? {}),
                usageTotals: merged,
                ...(usageCostUsd !== undefined ? { usageCostUsd } : {}),
              },
            });
          }
return undefined;
}
const __gateSignal = await (__gate125() ?? __gate126());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
function __gate128() {


return undefined;
}
try {
const __gateSignal = await __gate127();
if (__gateSignal) return __gateSignal;
} catch {
const __gateSignal = __gate128();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
async function __gate130() {
if (turnResult.usage) {
const __gateSignal = await __gate120();
if (__gateSignal) return __gateSignal;
}
if (turnResult.usage) {
        try {
          const cost = estimateUsageCostUsd(turnResult.usage, loopConfig.modelName);
          turnCostUsd = cost.usd;
          turnCostModel = cost.model;
        } catch {
          /* ignore */
        }
      }
void __gateExpr124();
return undefined;
}
function __gate131() {
if (turnResult.truncated) {
        void host.emitTrace(sid, {
          kind: 'turn_truncated',
          data: {
            finishReason: turnResult.finishReason ?? 'length',
            ...(turnResult.usage ? { outputTokens: turnResult.usage.outputTokens } : {}),
          },
        });
      }
return undefined;
}
async function __gate132() {
if (turnResult.usage) {
const __gateSignal = await __gate129();
if (__gateSignal) return __gateSignal;
}
recovery = decideTurnRecovery({
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        truncated: turnResult.truncated,
        assistantParts: turnResult.assistantParts,
        state: recoveryState,
        userAborted: signal.aborted,
      });
return undefined;
}
const __gateSignal = await (await __gate130() ?? __gate131() ?? await __gate132());
if (__gateSignal) return __gateSignal;
return undefined;
},
async () => {
async function __gate110() {
let recoveryOpts: any;
let chosen: any;
function __gate107() {
function __gate101() {

recovery = { action: 'continue' };
return undefined;
}
function __gate106() {
function __gate102() {

recovery = { action: 'end' };
return undefined;
}
function __gate105() {
function __gate103() {

recovery = { action: 'retry-same-input' };
return undefined;
}
function __gate104() {

if (chosen === 'retry-after-nudge') {
            recovery = {
              action: 'retry-after-nudge',
              nudge:
                recovery.action === 'retry-after-nudge'
                  ? recovery.nudge
                  : '[recovery] Retry after Jev recovery choice.',
            };
          } else if (chosen === 'abort') {
            recovery = {
              action: 'abort',
              reason: recovery.action === 'abort' ? recovery.reason : 'jev_recovery_choice',
            };
          }
return undefined;
}
if (chosen === 'retry-same-input') {
const __gateSignal = __gate103();
if (__gateSignal) return __gateSignal;
} else {
const __gateSignal = __gate104();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
if (chosen === 'end') {
const __gateSignal = __gate102();
if (__gateSignal) return __gateSignal;
} else {
const __gateSignal = __gate105();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
if (chosen === 'continue') {
const __gateSignal = __gate101();
if (__gateSignal) return __gateSignal;
} else {
const __gateSignal = __gate106();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
function __gate108() {
recoveryOpts = [
          { id: recovery.action, label: `Default: ${recovery.action}` },
        ];
if (recovery.action === 'retry-same-input' || recovery.action === 'retry-after-nudge') {
          recoveryOpts.push({ id: 'abort', label: 'Stop instead of retrying' });
          recoveryOpts.push({ id: 'end', label: 'End the turn without retry' });
        } else if (recovery.action === 'abort') {
          recoveryOpts.push({ id: 'retry-after-nudge', label: 'Nudge and retry once more' });
          recoveryOpts.push({ id: 'end', label: 'End cleanly without abort label' });
        } else if (recovery.action === 'end') {
          recoveryOpts.push({ id: 'continue', label: 'Continue the loop' });
        }
return undefined;
}
async function __gate109() {
chosen = await maybeChooseRecovery(
          `turn_recovery:${turnResult.stopReason}:${turnResult.finishReason ?? ''}`,
          recoveryOpts,
          recovery.action
        );
if (chosen !== recovery.action) {
const __gateSignal = __gate107();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
const __gateSignal = await (__gate108() ?? await __gate109());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
async function __gate111() {
if (recovery.action !== 'continue' || turnResult.truncated || turnResult.assistantParts.length === 0) {
const __gateSignal = await __gate110();
if (__gateSignal) return __gateSignal;
}
return undefined;
}
async function __gate112() {
if (discardedAssistant(recovery)) {
        void host.emitTrace(sid, {
          kind: 'recovery_advisory',
          data: {
            reason: 'leaked_tool_call',
            trigger: 'leaked_tool_call',
            exhausted: recovery.action === 'abort',
            stopReason: turnResult.stopReason,
          },
        });
      }
if (recovery.action === 'abort' && recovery.reason === 'user_abort') {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return kernelTurnSignal('return', await finishFailed(
          host.store.updateSession(session.id, { status: 'failed' }),
          'abort'
        ));
      }
if (recovery.action === 'retry-same-input') {
        host.store.appendMessage(sid, 'system', [
          textPart(
            '[recovery] Truncated/incomplete tool_call discarded; retrying the same input.'
          ),
        ]);
        return kernelTurnSignal('continue');
      }
return undefined;
}
function __gate113() {
if (recovery.action === 'retry-after-nudge') {
        if (!recovery.discardAssistant && turnResult.assistantParts.length > 0) {
          host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
        }
        host.store.appendMessage(sid, 'system', [textPart(recovery.nudge)]);
        return kernelTurnSignal('continue');
      }
return undefined;
}
async function __gate114() {
if (recovery.action === 'abort') {
        const reason = recovery.reason;
        host.store.appendMessage(sid, 'system', [
          textPart(
            reason === 'empty_assistant'
              ? '[recovery] Stopped: model returned no assistant content after retries.'
              : `[recovery] Stopped: ${reason}`
          ),
        ]);
        void host.emitTrace(sid, {
          kind: 'recovery_abort',
          data: { reason, trigger: 'turn_recovery' },
        });
        return kernelTurnSignal('return', await finishEnded(host.store.updateSession(session.id, { status: 'idle' }), reason));
      }
if (turnResult.assistantParts.length === 0) {
        host.store.appendMessage(sid, 'system', [
          textPart(
            '[recovery] Stopped: model returned no assistant content after retries.'
          ),
        ]);
        return kernelTurnSignal('return', await finishEnded(
          host.store.updateSession(session.id, { status: 'idle' }),
          'empty_assistant'
        ));
      }
spinReason = spinWatchdog?.noteParts(turnResult.assistantParts);
if (spinReason) {
        host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
        host.store.appendMessage(sid, 'system', [textPart(`[recovery] Stopped: ${spinReason}`)]);
        void host.emitTrace(sid, {
          kind: 'reasoning_spin_abort',
          data: { reason: spinReason, streak: spinWatchdog?.streak },
        });
        return kernelTurnSignal('return', await finishFailed(
          host.store.updateSession(session.id, { status: 'idle' }),
          'reasoning_spin'
        ));
      }
return undefined;
}
function __gate115() {
rawRep = loopGuard?.checkAssistantRepetition(turnResult.assistantParts) ?? { abort: false as const };
repSession = host.store.getSession(sid) ?? session;
repAdapter = adapterOf(repSession);
rep = applyRepeatGuard({
        store: host.store,
        identity: modelIdentity({
          modelName: repAdapter.modelName,
          adapterName: repAdapter.name,
          metadata: repSession.metadata,
        }),
        decision: rawRep,
      });
return undefined;
}
async function __gateGrp116() {
const __gateSignal = await (await __gate111() ?? await __gate112() ?? __gate113() ?? await __gate114());
if (__gateSignal) return __gateSignal;
return undefined;
}
function __gateGrp117() {
const __gateSignal = __gate115();
if (__gateSignal) return __gateSignal;
return undefined;
}
const __gateSignal = await (await __gateGrp116() ?? __gateGrp117());
if (__gateSignal) return __gateSignal;
return undefined;
},
async () => {
async function __gate89() {
let guardChoice: any;
async function __gate87() {
guardChoice = await maybeChooseRecovery(
          `loop_guard_repetition:${graceOut.reason}`,
          [
            { id: 'advise', label: 'Inject advisory and continue' },
            { id: 'abort', label: 'Stop the run for repetition' },
            { id: 'continue', label: 'Ignore and continue' },
          ],
          graceOut.action
        );
if (guardChoice === 'abort') {
          host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
          await host.injectRecoveryCoach?.({
            session,
            agent,
            trigger: 'repetition',
            reason: graceOut.reason,
          });
          host.store.appendMessage(session.id, 'system', [
            textPart(`[recovery] Stopped: ${graceOut.reason}`),
          ]);
          void host.emitTrace(sid, {
            kind: 'recovery_abort',
            data: { reason: graceOut.reason, trigger: 'repetition' },
          });
          host.onSessionOutcome?.({
            sessionId: session.id,
            agentId: agent.id,
            outcome: 'failure',
            signals: { trigger: 'repetition', reason: graceOut.reason },
          });
          if (await tryAutoFork('repetition-aborted')) return kernelTurnSignal('continue');
          return kernelTurnSignal('return', await finishFailed(
            host.store.updateSession(session.id, { status: 'idle' }),
            'repetition'
          ));
        }
return undefined;
}
async function __gate88() {
if (guardChoice === 'advise') {
          const strike = noteCriticalHit(recoveryState);
          if (strike.action === 'abort') {
            host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
            host.store.appendMessage(session.id, 'system', [
              textPart(`[recovery] Stopped: ${graceOut.reason} (critical strike)`),
            ]);
            if (await tryAutoFork('repetition-aborted')) return kernelTurnSignal('continue');
            return kernelTurnSignal('return', await finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            ));
          }
          pendingRecoveryAdvisory =
            graceOut.action === 'advise'
              ? graceOut.advisory
              : `[recovery-advisory] ${graceOut.reason}`;
          void host.emitTrace(sid, {
            kind: 'recovery_advisory',
            data: { reason: graceOut.reason, trigger: 'repetition' },
          });
        }
return undefined;
}
const __gateSignal = await (await __gate87() ?? await __gate88());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
async function __gate97() {
let stopPhase: any;
let stopHook: any;
let goal: any;
let steeredNow: any;
async function __gate90() {
stopPhase = context.session.mode === 'subagent' ? 'subagent_stop' : 'stop';
stopHook = await host.runLifecycleHook?.({
          phase: stopPhase,
          sessionId: sid,
          agentId: agent.id,
          meta: { stopReason: turnResult.stopReason },
        });
if (stopHook?.block) {
          const msg = stopHook.message ?? stopHook.systemMessage ?? 'stop blocked; continuing';
          host.store.appendMessage(sid, 'system', [textPart(`[stop-hook] ${msg}`)]);
          return kernelTurnSignal('continue');
        }
return undefined;
}
async function __gate91() {
if (stopHook?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(stopHook.systemMessage)]);
        }
goal = await host.evaluateGoalGate?.({
          session: sessionForTurn(host, sid, session),
          agent,
          signal,
          workspaceRoot: workspaceRoot ?? host.repoRoot,
        });
return undefined;
}
function __gate92() {
if (goal?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(goal.systemMessage)]);
        } else if (goal && !goal.met) {
          host.store.appendMessage(sid, 'system', [
            textPart(`[goal] not yet met: ${goal.reason ?? 'continuing'}`),
          ]);
        }
return undefined;
}
async function __gate93() {
if (goal && (!goal.met || goal.action === 'continue')) {
          return kernelTurnSignal('continue');
        }
if (host.waitSteeringChildrenIdle) {
          await host.waitSteeringChildrenIdle(sid);
        }
steeredNow = claimAndApplyInbox(host.store, sid, 'next-step', {
          expectedWriterRunId: writerRunId,
        });
return undefined;
}
async function __gate94() {
if (steeredNow.length > 0) return kernelTurnSignal('continue');
host.onSessionOutcome?.({
          sessionId: session.id,
          agentId: agent.id,
          outcome: 'success',
        });
return kernelTurnSignal('return', await host.handleTurnCompletion(session, agent).then((completed) =>
          finishEnded(completed, 'end')
        ));
return undefined;
}
async function __gateGrp95() {
const __gateSignal = await (await __gate90() ?? await __gate91() ?? __gate92() ?? await __gate93());
if (__gateSignal) return __gateSignal;
return undefined;
}
async function __gateGrp96() {
const __gateSignal = await (await __gate94());
if (__gateSignal) return __gateSignal;
return undefined;
}
const __gateSignal = await (await __gateGrp95() ?? await __gateGrp96());
if (__gateSignal) return __gateSignal;
return undefined;
return undefined;
}
async function __gate98() {
graceOut = advisoryGrace.apply(rep.abort ? { abort: true, reason: rep.reason } : { abort: false });
if (graceOut.action === 'advise' || graceOut.action === 'abort') {
const __gateSignal = await __gate89();
if (__gateSignal) return __gateSignal;
}
modelStep = stepInfo(turn, 'model_done');
await host.stepTx?.beginStep?.(modelStep);
assistantMessage = host.store.appendMessage(
        session.id,
        'assistant',
        turnResult.assistantParts
      );
return undefined;
}
async function __gate99() {
if (pendingRecoveryAdvisory) {
        host.store.appendMessage(session.id, 'system', [textPart(pendingRecoveryAdvisory)]);
      }
await emitStep({
        type: 'model_done',
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        truncated: turnResult.truncated,
        assistant: { parts: turnResult.assistantParts },
      });
await host.stepTx?.commitStep?.(modelStep);
if (recovery.action !== 'continue') {
const __gateSignal = await __gate97();
if (__gateSignal) return __gateSignal;
}
type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
rawToolCalls = assistantMessage.parts.filter(
        (part: MessagePart): part is ToolCallPart => part.type === 'tool_call'
      );
toolCalls = host.filterValidToolCalls
        ? host.filterValidToolCalls(rawToolCalls, allowExternalAiTools, sid, resolvedTools)
        : rawToolCalls;
return undefined;
}
async function __gate100() {
if (toolCalls.length === 0) {
        return kernelTurnSignal('continue');
      }
if (signal.aborted) {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return kernelTurnSignal('return', await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort'));
      }
closedByGate = { reported: false, ids: [] as string[] };
return undefined;
}
const __gateSignal = await (await __gate98() ?? await __gate99() ?? await __gate100());
if (__gateSignal) return __gateSignal;
return undefined;
},
async () => {
async function __gate77() {
approvalResult = (await host.checkToolApprovals?.(toolCalls, context, sessionForTurn(host, sid, session), {
          filePolicy,
          turnTools: resolvedTools,
          closedByGate,
        })) ?? 'proceed';
hostLatch = loopConfig.hitlLatch
        ? await host.shouldLatchBeforeTools?.({ session, toolCalls })
        : undefined;
latch = decideHitlLatch({
        aborted: signal.aborted,
        approval: approvalResult,
        hostLatch,
      });
parkForApproval = async () => {
        host.noteGoalWaitingUser?.(sid, toolCalls);
        const approvalIds = host.store
          .listApprovals({ status: 'pending' })
          .filter((a) => a.sessionId === sid)
          .map((a) => a.id);
        const interrupt = createWaitingApprovalInterrupt({
          toolCallIds: toolCalls.map((c: { toolCallId: string }) => c.toolCallId),
          approvalIds,
          writerRunId,
        });
        const current = host.store.getSession(sid) as SessionRecord;
        const outcome = runOutcomeFromEnd({
          reason: 'waiting_approval',
          sessionStatus: 'waiting_approval',
        });
        const updated = host.store.updateSession(sid, {
          status: 'waiting_approval',
          metadata: mergeInterruptMetadata(
            mergeOutcomeMetadata(current.metadata ?? {}, outcome),
            interrupt
          ),
        });
        await emitStep({ type: 'waiting_approval', approvalIds, interrupt });
        return updated;
      };
if (latch.action === 'abort') {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return kernelTurnSignal('return', await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort'));
      }
if (latch.action === 'waiting') {
        return kernelTurnSignal('return', await parkForApproval());
      }
return undefined;
}
async function __gate78() {
if (latch.action === 'skip') {
        return kernelTurnSignal('continue');
      }
if (latch.action === 'steer') {
        closeWaveIfOpen();
        return kernelTurnSignal('return', await finishEnded(host.store.updateSession(session.id, { status: 'idle' }), 'steering'));
      }
drainPolicy = resolveSteerDrainPolicy({
        option: options?.steerDrainPolicy,
        sessionMetadata: host.store.getSession(sid)?.metadata,
        store: host.store,
      });
if (typeof host.store.claimInbox === 'function' && typeof host.store.hideByKey === 'function') {
        drainSteerAtToolLaunch({
          store: host.store as unknown as SteerDrainClaimStore,
          sessionId: sid,
          toolCallIds: toolCalls.map((c: { toolCallId: string }) => c.toolCallId),
          policy: drainPolicy,
          expectedWriterRunId: writerRunId,
        });
      }
executable = selectExecutableToolCalls(toolCalls, closedByGate, () =>
        unmatchedToolCallsFromFold(
          host.store.foldMessages(sid),
          toolCalls.map((call: { toolCallId: string }) => call.toolCallId)
        )
      );
return undefined;
}
async function __gate79() {
if (executable.length === 0) {
        return kernelTurnSignal('continue');
      }
toolsStep = stepInfo(turn, 'tools_done');
await host.stepTx?.beginStep?.(toolsStep);
results = await host.executeToolCalls(
        executable,
        context,
        allowExternalAiTools,
        sid,
        resolvedTools
      );
host.processToolResults(
        resultsToPersist(results),
        executable,
        context.session,
        undefined,
        sid,
        options?.onModelStreamChunk
      );
if (toolWaveHeldForApproval(results)) {
        return kernelTurnSignal('return', await parkForApproval());
      }
for (const r of results) {
        host.recordToolUse?.({ name: r.name, sessionId: sid, turn, ok: r.ok });
      }
await emitStep({
        type: 'tools_done',
        results: results.map((r: { ok: boolean; content: string; name: string }) => ({ ok: r.ok, content: r.content, name: r.name })),
      });
await host.stepTx?.commitStep?.(toolsStep);
return undefined;
}
async function __gate80() {
if (stopAt.size > 0) {
        const hit = results.find((r: { ok: boolean; name: string }) => r.ok && stopAt.has(r.name));
        if (hit) {
          return kernelTurnSignal('return', await finishEnded(
            host.store.updateSession(session.id, { status: 'idle' }),
            `stop_at:${hit.name}`
          ));
        }
      }
progressDecision = progressGuard.afterToolRound(
        executable,
        results
      );
return undefined;
}
function __gate81() {
if (riskEngine) {
        for (const r of results) {
          riskEngine.observeTool({ toolName: r.name, success: r.ok, errorMessage: r.ok ? undefined : r.content });
        }
        const usageTotals = host.store.getSession(sid)?.metadata?.usageTotals as
          | TokenUsage
          | undefined;
        const tick = riskEngine.tick({
          iteration: turn,
          iterationLimit: maxTurns,
          usedTokens: usageTotals?.totalTokens,
          budgetTokens: loopConfig.budgetTokens,
          sameToolStreak: progressGuard.sameToolStreak,
          sameToolThreshold: progressGuard.sameToolThreshold,
        });
        if (tick.shouldAdvise) {
          const draft = advisoryQueue.enqueue(formatRiskAdvisory(tick.signals), 'risk');
          void host.emitTrace(sid, {
            kind: 'risk_advisory',
            data: { reason: tick.reason, signals: tick.signals, advisoryId: draft.id },
          });
        }
      }
return undefined;
}
function __gate82() {
toolRep = loopGuard ? progressDecision : { abort: false as const };
live = host.store.getSession(sid) ?? session;
adapter = adapterOf(live);
guarded = applyRepeatGuard({
        store: host.store,
        identity: modelIdentity({
          modelName: adapter.modelName,
          adapterName: adapter.name,
          metadata: live.metadata,
        }),
        decision: toolRep,
      });
toolRepDecision = guarded.abort
        ? { abort: true, reason: guarded.reason }
        : { abort: false, reason: '' };
toolGraceOut = advisoryGrace.apply(toolRepDecision);
return undefined;
}
async function __gate83() {
if (toolGraceOut.action === 'advise') {
        const strike = noteCriticalHit(recoveryState);
        if (strike.action === 'abort') {
          host.store.appendMessage(session.id, 'system', [
            textPart(`[recovery] Stopped: ${toolGraceOut.reason} (critical strike)`),
          ]);
          if (await tryAutoFork('deadloop-exhausted')) return kernelTurnSignal('continue');
          return kernelTurnSignal('return', await finishFailed(
            host.store.updateSession(session.id, { status: 'idle' }),
            loopGuardStopReason(toolGraceOut.reason)
          ));
        }
        host.store.appendMessage(session.id, 'system', [textPart(toolGraceOut.advisory)]);
        void host.emitTrace(sid, {
          kind: 'recovery_advisory',
          data: { reason: toolGraceOut.reason, trigger: 'tools' },
        });
        return kernelTurnSignal('continue');
      }
return undefined;
}
async function __gate84() {
if (toolGraceOut.action === 'abort') {
        await host.injectRecoveryCoach?.({
          session,
          agent,
          trigger: 'tools',
          reason: toolGraceOut.reason,
        });
        host.store.appendMessage(session.id, 'system', [
          textPart(`[recovery] Stopped: ${toolGraceOut.reason}`),
        ]);
        void host.emitTrace(sid, {
          kind: 'recovery_abort',
          data: { reason: toolGraceOut.reason, trigger: 'tools' },
        });
        if (await tryAutoFork('deadloop-exhausted')) return kernelTurnSignal('continue');
        return kernelTurnSignal('return', await finishFailed(
          host.store.updateSession(session.id, { status: 'idle' }),
          loopGuardStopReason(toolGraceOut.reason)
        ));
      }
return undefined;
}
async function __gateGrp85() {
const __gateSignal = await (await __gate77() ?? await __gate78() ?? await __gate79() ?? await __gate80());
if (__gateSignal) return __gateSignal;
return undefined;
}
async function __gateGrp86() {
const __gateSignal = await (__gate81() ?? __gate82() ?? await __gate83() ?? await __gate84());
if (__gateSignal) return __gateSignal;
return undefined;
}
const __gateSignal = await (await __gateGrp85() ?? await __gateGrp86());
if (__gateSignal) return __gateSignal;
return undefined;
}
];
for (const kernelStep of kernelSteps) {
const kernelFlow = await kernelStep();
if (kernelTurnStop(kernelFlow)) return kernelFlow;
}
return undefined;
})();
const kernelStop = kernelTurnStop(kernelTurnFlow);
if (kernelStop === 'continue') continue;
if (kernelStop === 'break') break;
if (kernelStop === 'return') return (kernelTurnFlow as KernelTurnFlow).value as SessionRecord;
}
return undefined;
})();
if (kernelFinished !== undefined) return kernelFinished as SessionRecord;
}

    host.onSessionOutcome?.({
      sessionId: session.id,
      agentId: agent.id,
      outcome: 'partial',
      signals: {
        reason: 'max_turns_exhausted',
        maxTurns: Number.isFinite(maxTurns) ? maxTurns : 0,
      },
    });
    return await finishEnded(
      host.store.updateSession(session.id, { status: 'idle' }),
      'max_turns'
    );
  } catch (err) {
    emitKernelReady(startup);
    if (host.store.isWriterCurrent && !host.store.isWriterCurrent(sid, writerRunId)) {
      host.emitTrace(sid, { kind: 'stale_writer_rejected', payload: { writerRunId } });
      return host.store.getSession(sid) ?? session;
    }
    const aborted =
      signal.aborted || (err instanceof Error && /session aborted/i.test(err.message));
    closeWaveIfOpen();
    const rewindReason = aborted
      ? 'abort'
      : rollbackReasonOf({ runError: err instanceof Error ? err.message : String(err) }) ?? 'run-error';
    const rewind = await rewindUncommitted(rewindReason);
    const current = host.store.getSession(sid);
    if (current) {
      persistOutcome(
        host.store.updateSession(sid, { status: 'failed' }),
        aborted ? 'abort' : 'model_error',
        rewind
      );
    }
    emitKernelReady(startup);
    throw err;
  }
}

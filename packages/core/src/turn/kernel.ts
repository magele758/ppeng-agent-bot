/**
 * L3 turn kernel: one session run (prepare → model → recovery → tools).
 * Behavior-preserving move of RawAgentRuntime._runSessionInner.
 */

import { createHash } from 'node:crypto';
import { NotFoundError } from '../errors.js';
import { resolveSessionMaxTurns } from '../runtime/session-max-turns.js';
import { envBool, envInt } from '../env.js';
import { createId } from '../id.js';
import { STABLE_SYSTEM_VERSION, type PromptContext } from '../model/prompt-builder.js';
import { foldGoalJudgeSnapshot } from './goal-snapshot.js';
import {
  lifecycleBlocks,
  runLifecycleHook
} from '../hooks/lifecycle-hooks.js';
import {
  isRepetitionAbort,
  loadReasoningSpinWatchdogConfig,
  ReasoningSpinWatchdog,
  reasoningSpinWatchdogEnabled
} from '@ppeng/agent-loop';
import {
  AdvisoryGrace,
  AdvisoryQueue,
  advisoryGraceBudget,
  advisoryGraceEnabled
} from '@ppeng/agent-loop';
import {
  formatRiskAdvisory,
  recoveryPolicyEnabled,
  RiskEngine,
  riskEngineConfigFromEnv,
  riskEngineEnabled,
  SessionLoopGuard
} from '@ppeng/agent-loop';
import { applyJevRoute, applyJevToolSelect, applyJevPreTurn, applyJevRecoveryChoice, selectGoalJudge } from '../jev/apply.js';
import {
  createGoalGateFromMetadata,
  ensureGoalEntityFromMetadata,
  markGoalWaitingUser,
  persistGoalAfterEval,
  readGoalSettings,
  runGoalVerify,
  tryGoalStore,
  type GoalGate
} from '../goal/index.js';
import { estimateUsageCostUsd, llmPromptDebugEnabled, mergeCostUsd, mergeUsage, splitCumulativePromptTokens } from '@ppeng/agent-loop';
import { readWorkingLogAppendix } from '../session/working-log.js';
import { applyClaimedInbox, prepareTurnInput } from './prepare-turn-input.js';
import {
  createTurnRecoveryState,
  decideTurnRecovery,
  discardedAssistant,
  noteCriticalHit,
  toolCallParts
} from './turn-recovery.js';
import { resolveModelStopReason } from '@ppeng/agent-loop';
import { capSessionMap } from './prepare-view.js';
import { resolveTurnTools } from './resolve-turn-tools.js';
import {
  hydrateTurnDynTools,
  mergeDynToolsUsed,
  queryForDynHydrate,
  readDynToolsUsed,
  tryCreateDynToolStore
} from '../dyn-tools/index.js';
import { filterToolsForSession } from './resolve-turn-tools.js';
import { isContextOverflowError } from '../session/auto-compact.js';
import type { AgentLoopLatch, AgentStepEvent } from '../runtime/agent-loop.js';
import {
  createWaitingApprovalInterrupt,
  decideInterruptResume,
  mergeInterruptMetadata,
  unmatchedToolCallsFromFold,
  selectExecutableToolCalls,
  type RunInterruptState
} from '../session/interrupt.js';
import {
  mergeOutcomeMetadata,
  runOutcomeFromEnd,
  type RunOutcome,
  type RunOutcomeRewind
} from '../session/run-outcome.js';
import {
  latestCheckpoint,
  rewindUncommittedTail,
  saveStepCheckpoint
} from '../session/checkpoint.js';
import {
  beginEventLogRun,
  commitEventLogStep,
  endEventLogRun,
  retractEventLogUncommitted
} from '../session/event-log-saga.js';
import { decideAutoFork, isAutoForkUsed, AUTO_FORK_USED_KEY } from '../session/auto-fork.js';
import { waitSteeringChildrenIdle } from '../session/steering-subagent.js';
import { closeOpenToolWave, TOOL_WAVE_SKIPPED_STEER_CONTENT } from '../session/tool-wave-close.js';
import {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  type SteerDrainPolicy
} from '../session/steer-drain.js';
import type {
  AgentSpec,
  MessagePart,
  ModelStreamChunk,
  ModelTurnResult,
  RunContext,
  SessionRecord,
  TokenUsage
} from '../types.js';
import type { ToolCallPart, TurnKernelHost } from './host.js';
import { buildSkillProposeReminder } from '../skill-proposals/reminder.js';
import {
  defaultWorkspaceRoots,
  resolveEffectiveWorkspace,
  workspaceBindingFromMetadata,
  type WorkspaceStoreHost
} from '../workspace/index.js';

function hasWorkspaceStores(store: unknown): store is WorkspaceStoreHost {
  return (
    !!store &&
    typeof (store as WorkspaceStoreHost).projects === 'function' &&
    typeof (store as WorkspaceStoreHost).cloudFolders === 'function'
  );
}

function textPart(text: string): MessagePart {
  return { type: 'text', text };
}

async function hydrateResolveTurnTools(
  host: TurnKernelHost,
  session: SessionRecord,
  agent: AgentSpec,
  sid: string,
  query: string,
  systemPromptChars: number
): Promise<{
  dynHydrated: ReturnType<typeof hydrateTurnDynTools>;
  selectedTools: ReturnType<typeof resolveTurnTools>;
}> {
  host.syncConnectorTools?.();
  const dynHydrated = hydrateTurnDynTools({
    store: host.store,
    session,
    query,
    materializeDeps: {
      getAuthorizedTools: (ctx) =>
        filterToolsForSession({
          env: process.env,
          tools: host.tools,
          agent: ctx.agent,
          session: ctx.session,
          settingsStore: host.store
        }).tools,
      previewAuthorizedTools: filterToolsForSession({
        env: process.env,
        tools: host.tools,
        agent,
        session,
        settingsStore: host.store
      }).tools,
      emitTrace: (sessionId, event) => {
        void host.emitTrace(sessionId, event as Parameters<typeof host.emitTrace>[1]);
      }
    }
  });
  const selectedTools = resolveTurnTools({
    env: process.env,
    tools: host.tools,
    agent,
    session,
    sessionId: sid,
    systemPromptChars,
    settingsStore: host.store,
    dynTools: dynHydrated.tools
  });
  const names = await applyJevToolSelect(
    host.store,
    query,
    selectedTools.turnTools.map((t) => ({ name: t.name, description: t.description })),
    { preserveExposure: true }
  );
  if (names) {
    const keep = new Set(names);
    return {
      dynHydrated,
      selectedTools: {
        ...selectedTools,
        turnTools: selectedTools.turnTools.filter((t) => keep.has(t.name)),
        turnShape: {
          ...selectedTools.turnShape,
          toolCount: selectedTools.turnTools.filter((t) => keep.has(t.name)).length
        }
      }
    };
  }
  return { dynHydrated, selectedTools };
}

function recordDynToolUses(
  host: TurnKernelHost,
  sid: string,
  turn: number,
  results: Array<{ ok: boolean; name: string }>,
  dynNames: string[]
): void {
  const dynUsedNow = results.filter((r) => r.ok && dynNames.includes(r.name)).map((r) => r.name);
  if (dynUsedNow.length === 0) return;
  const current = host.store.getSession(sid);
  const prev = readDynToolsUsed(current ?? { metadata: {} });
  host.mergeSessionMetadata(sid, { dynToolsUsed: mergeDynToolsUsed(prev, dynUsedNow) });
  const dynStore = tryCreateDynToolStore(host.store as Parameters<typeof tryCreateDynToolStore>[0]);
  for (const name of dynUsedNow) {
    dynStore?.recordUse(name, sid, turn);
  }
}

function emitDynHydrateTrace(
  host: TurnKernelHost,
  sid: string,
  dynHydrated: ReturnType<typeof hydrateTurnDynTools>
): void {
  if (dynHydrated.names.length === 0 && dynHydrated.skipped.length === 0) return;
  void host.emitTrace(sid, {
    kind: 'dyn_tool_hydrate',
    payload: {
      names: dynHydrated.names,
      suggestRetired: dynHydrated.suggestRetired,
      ...(dynHydrated.skipped.length > 0 ? { skipped: dynHydrated.skipped } : {})
    }
  });
}

/** Put a yielded session back into waiting_approval when a decision had cleared it. */
export function sessionParkedForApproval<T extends { id: string; status: string }>(
  store: { updateSession(id: string, patch: { status: 'waiting_approval' }): T },
  session: T
): T {
  if (session.status === 'waiting_approval') return session;
  return store.updateSession(session.id, { status: 'waiting_approval' });
}

/**
 * Re-check approvals for a resumed tool wave. Returns the parked session when
 * the wave is still waiting; otherwise executes whatever the gate left open.
 */
export async function continueResumedToolWave(input: {
  host: TurnKernelHost;
  agent: AgentSpec;
  sessionId: string;
  turn: number;
  remaining: ToolCallPart[];
  context: RunContext;
  filePolicy: Awaited<ReturnType<TurnKernelHost['mergedFilePolicy']>>;
  allowExternalAiTools: boolean;
  interrupt: RunInterruptState;
  writerRunId: string;
  session: SessionRecord;
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
  emitStep: (ev: AgentStepEvent) => Promise<void>;
}): Promise<SessionRecord | undefined> {
  const { dynHydrated, selectedTools } = await hydrateResolveTurnTools(
    input.host,
    input.context.session,
    input.agent,
    input.sessionId,
    queryForDynHydrate(input.host.store.foldMessages(input.sessionId)),
    0
  );
  emitDynHydrateTrace(input.host, input.sessionId, dynHydrated);
  const closedByGate = { reported: false, ids: [] as string[] };
  const gate = await input.host.checkToolApprovals(
    input.remaining,
    input.context,
    input.filePolicy,
    input.context.session,
    selectedTools.turnTools,
    closedByGate,
    input.interrupt.approvalIds
  );
  if (gate === 'waiting') {
    const approvalIds = input.host.store
      .listApprovals({ status: 'pending' })
      .filter((approval) => approval.sessionId === input.sessionId)
      .map((approval) => approval.id);
    const nextInterrupt = createWaitingApprovalInterrupt({
      toolCallIds: input.remaining.map((call) => call.toolCallId),
      approvalIds,
      writerRunId: input.writerRunId,
      executedToolCallIds: input.interrupt.executedToolCallIds
    });
    const current = input.host.store.getSession(input.sessionId) as SessionRecord;
    return input.host.store.updateSession(input.sessionId, {
      status: 'waiting_approval',
      metadata: mergeInterruptMetadata(current.metadata ?? {}, nextInterrupt)
    });
  }
  if (gate === 'skip') return undefined;
  const allowIds = input.interrupt.toolCallIds.filter(
    (id) => !input.interrupt.executedToolCallIds.includes(id)
  );
  const executable = selectExecutableToolCalls(input.remaining, closedByGate, () =>
    unmatchedToolCallsFromFold(input.host.store.foldMessages(input.sessionId), allowIds)
  );
  if (executable.length === 0) return undefined;
  const results = await input.host.executeToolCalls(
    executable,
    input.context,
    input.allowExternalAiTools,
    input.sessionId,
    selectedTools.turnTools
  );
  input.host.processToolResults(
    results,
    executable,
    input.session,
    input.context.task,
    input.sessionId,
    input.onModelStreamChunk
  );
  recordDynToolUses(input.host, input.sessionId, input.turn, results, dynHydrated.names);
  await input.emitStep({
    type: 'tools_done',
    results: results.map((result) => ({ ok: result.ok, content: result.content, name: result.name }))
  });
  return undefined;
}

interface KernelRunOptions {
  onModelStreamChunk?: (chunk: ModelStreamChunk) => void;
  latch?: AgentLoopLatch;
  steerDrainPolicy?: SteerDrainPolicy;
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
  options?: KernelRunOptions
): Promise<SessionRecord> {
  const session: SessionRecord = host.store.getSession(sessionId)!;
  if (!session) {
    throw new NotFoundError('Session', sessionId);
  }

  const pendingApprovalIds = host.store
    .listApprovals({ status: 'pending' })
    .filter((a) => a.sessionId === sessionId)
    .map((a) => a.id);
  const resumeDecision = decideInterruptResume({ session, pendingApprovalIds });

  const existingController = host.sessionAbortControllers.get(sessionId);
  const controller = existingController ?? new AbortController();
  host.sessionAbortControllers.set(sessionId, controller);
  const sid = session.id;
  const writerRunId = createId('run');
  try { host.store.claimWriter(sessionId, writerRunId); }
  catch (error) {
    if (!existingController && host.sessionAbortControllers?.get(sessionId) === controller) host.sessionAbortControllers.delete(sessionId);
    throw error;
  }
  const settle = async (): Promise<SessionRecord> => {
    try {
      // Admission may follow another executor completing or replacing this pause.
      // Recompute from persisted state while writes are bound to our new claim.
      const admittedSession = host.store.getSession(sid);
      if (!admittedSession) throw new NotFoundError('Session', sid);
      const decision = decideInterruptResume({
        session: admittedSession,
        pendingApprovalIds: host.store.listApprovals({ status: 'pending' }).filter(a => a.sessionId === sid).map(a => a.id)
      });
      if (decision.action === 'yield_waiting') {
        const parked = sessionParkedForApproval(host.store, admittedSession);
        await options?.latch?.emit({ type: 'waiting_approval', approvalIds: decision.interrupt.approvalIds, interrupt: decision.interrupt });
        return parked;
      }
      if (resumeDecision.action !== 'none' && decision.action === 'none') return admittedSession;
      const agent = host.store.getAgent(admittedSession.agentId);
      if (!agent) throw new NotFoundError('Agent', admittedSession.agentId);
      const resumeFromInterrupt = decision.action === 'resume_tools' ? decision.interrupt : undefined;
      return await runSessionKernel(host, sessionId, { session: admittedSession, agent, controller, writerRunId, resumeFromInterrupt }, options);
    }
    finally {
      if (host.sessionAbortControllers?.get(sid) === controller) host.sessionAbortControllers.delete(sid);
      host.store.releaseWriter(sid, writerRunId);
    }
  };
  return host.store.runWithWriter ? host.store.runWithWriter(sid, writerRunId, settle) : settle();
}

async function runSessionKernel(
  host: TurnKernelHost,
  sessionId: string,
  execution: KernelExecution,
  options?: KernelRunOptions
): Promise<SessionRecord> {
  let { session, resumeFromInterrupt } = execution;
  const { agent, controller, writerRunId } = execution;
  const signal = controller.signal;
  const sid = session.id;
  try {
    beginEventLogRun(host.store, sid, writerRunId);
  } catch {
    /* fail-soft */
  }
  const emitStep = async (ev: AgentStepEvent) => {
    if (options?.latch) await options.latch.emit(ev);
  };
  const persistOutcome = (
    record: SessionRecord,
    reason: string,
    rewind?: RunOutcomeRewind
  ): { record: SessionRecord; outcome: RunOutcome } => {
    const outcome = runOutcomeFromEnd({ reason, sessionStatus: record.status, rewind });
    const next = host.store.updateSession(record.id, {
      metadata: mergeOutcomeMetadata(record.metadata ?? {}, outcome)
    });
    return { record: next, outcome };
  };
  const rewindTail = (reason: string): RunOutcomeRewind | undefined => {
    try {
      retractEventLogUncommitted(host.store, sid, reason);
    } catch {
      /* EventLog retract is independent of WAL hide */
    }
    try {
      const result = rewindUncommittedTail(host.store, sid, { reason });
      if (!result.rewound) return undefined;
      return { toSeq: result.toSeq, shadowedCount: result.shadowedCount, reason: result.reason };
    } catch {
      return undefined;
    }
  };
  const finishFailed = async (record: SessionRecord, reason: string) => {
    const rewind = rewindTail(reason);
    const current = host.store.getSession(sid) ?? record;
    const { record: next, outcome } = persistOutcome(current, reason, rewind);
    void host.emitTrace(next.id, {
      kind: 'turn_end',
      payload: { terminal: true, reason, outcome }
    });
    await emitStep({ type: 'ended', reason, outcome });
    return next;
  };
  const saveClosedStep = (turn: number, label: string) => {
    try {
      saveStepCheckpoint(host.store, sid, { turn, label });
    } catch {
      /* fail-soft */
    }
    try {
      commitEventLogStep(host.store, sid, { turn, label });
    } catch {
      /* fail-soft */
    }
  };
  const tryAutoFork = (trigger: 'repetition-aborted' | 'deadloop-exhausted'): boolean => {
    try {
      const current = host.store.getSession(sid);
      const nodes = host.store.listSurfaceNodes(sid);
      const decision = decideAutoFork({
        trigger,
        alreadyUsed: isAutoForkUsed(current?.metadata),
        checkpoint: latestCheckpoint(current?.metadata),
        currentSeq: nodes[nodes.length - 1]?.seq ?? 0
      });
      if (!decision.shouldFork || !decision.guidance) return false;
      rewindUncommittedTail(host.store, sid, { reason: trigger });
      host.mergeSessionMetadata(sid, { [AUTO_FORK_USED_KEY]: true });
      host.store.appendMessage(sid, 'system', [textPart(decision.guidance)]);
      return true;
    } catch {
      return false;
    }
  };
  const finishEnded = async (record: SessionRecord, reason: string) => {
    try {
      endEventLogRun(host.store, sid, { runId: writerRunId, reason });
    } catch {
      /* fail-soft */
    }
    const { record: next, outcome } = persistOutcome(record, reason);
    void host.emitTrace(next.id, {
      kind: 'turn_end',
      payload: { terminal: true, reason, outcome }
    });
    await emitStep({ type: 'ended', reason, outcome });
    return next;
  };
  const closeWaveIfOpen = () => {
    try {
      closeOpenToolWave(host.store, sid, 'interrupted');
    } catch {
      /* best-effort */
    }
  };
  const loopGuard = recoveryPolicyEnabled(process.env) ? new SessionLoopGuard(process.env) : null;
  const advisoryGrace =
    loopGuard && advisoryGraceEnabled(process.env)
      ? new AdvisoryGrace(advisoryGraceBudget(process.env))
      : null;
  const advisoryQueue = new AdvisoryQueue();
  const riskEngine = riskEngineEnabled(process.env)
    ? new RiskEngine(riskEngineConfigFromEnv(process.env))
    : null;
  const adapterOf = (sess: SessionRecord) =>
    host.resolveModelAdapter?.(sess) ?? host.modelAdapter;
  const goalGate: GoalGate | null = createGoalGateFromMetadata(session.metadata, process.env);
  const goalStore = tryGoalStore(host.store);
  if (goalGate?.isActive() && goalStore) {
    try {
      ensureGoalEntityFromMetadata(goalStore, sid, session.metadata, {
        getDaemonControl: <T>(key: string) => host.store.getDaemonControl?.(key) as T | undefined
      });
    } catch {
      /* fail-soft */
    }
  }
  const spinWatchdog = reasoningSpinWatchdogEnabled(process.env)
    ? new ReasoningSpinWatchdog(loadReasoningSpinWatchdogConfig(process.env))
    : null;
  const recoveryState = createTurnRecoveryState();
  try {
    host.runCaseGovernance();
  } catch {
    /* fail-soft */
  }
  riskEngine?.noteUserIntervention(0);

  const maxTurnsPerRun = resolveSessionMaxTurns(session.metadata, host.maxTurnsPerRun);

  try {
    await host.mcpManager.ensureLoaded(sid);
    const filePolicy = await host.mergedFilePolicy();
    session = host.store.updateSession(session.id, { status: 'running' });
    await host.ingestMailbox(session);
    await host.autoClaimTask(session);
    const nextRunItems = host.store.claimInbox(sid, 'next-run');
    if (nextRunItems.length > 0) {
      applyClaimedInbox(host.store, sid, nextRunItems);
    }

    for (let turn = 0; turn < maxTurnsPerRun; turn += 1) {
      if (signal.aborted) {
        closeWaveIfOpen();
        return await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
      }

      const refreshedSession = host.store.getSession(session.id) as SessionRecord;
      const task = refreshedSession.taskId ? host.store.getTask(refreshedSession.taskId) : undefined;
      const workspaceRoot = await host.ensureWorkspaceRoot(refreshedSession, task);
      let workspaceRoots = defaultWorkspaceRoots(workspaceRoot, host.repoRoot);
      if (hasWorkspaceStores(host.store)) {
        const binding = workspaceBindingFromMetadata(refreshedSession.metadata);
        if (binding.kind !== 'default') {
          const effective = await resolveEffectiveWorkspace({
            store: host.store,
            session: refreshedSession,
            repoRoot: host.repoRoot,
            stateDir: host.stateDir,
            isolatedWorkspaceRoot: workspaceRoot
          });
          workspaceRoots = effective.workspaceRoots;
        }
      }
      let context: RunContext = {
        repoRoot: host.repoRoot,
        stateDir: host.stateDir,
        session: host.store.getSession(session.id) as SessionRecord,
        agent,
        workspaceRoot,
        workspaceRoots,
        task,
        abortSignal: signal
      };

      if (resumeFromInterrupt) {
        const interrupt = resumeFromInterrupt;
        resumeFromInterrupt = undefined;
        const claimed = host.store.claimInbox(sid, 'next-step');
        if (claimed.length > 0) {
          applyClaimedInbox(host.store, sid, claimed);
        }
        const remaining = unmatchedToolCallsFromFold(
          host.store.foldMessages(sid),
          interrupt.toolCallIds.filter((id) => !interrupt.executedToolCallIds.includes(id))
        );
        const sessionOptIn = context.session.metadata?.allowExternalAiTools === true;
        const allowExt = envBool(process.env, 'RAW_AGENT_EXTERNAL_AI_TOOLS', false) && sessionOptIn;
        if (remaining.length > 0) {
          const parked = await continueResumedToolWave({
            host,
            agent,
            sessionId: sid,
            turn,
            remaining,
            context,
            filePolicy,
            allowExternalAiTools: allowExt,
            interrupt,
            writerRunId,
            session,
            onModelStreamChunk: options?.onModelStreamChunk,
            emitStep
          });
          if (parked) return parked;
        }
        const after = host.store.getSession(sid);
        host.store.updateSession(sid, {
          metadata: mergeInterruptMetadata(after?.metadata ?? {}, null)
        });
        continue;
      }

      const packed = await prepareTurnInput(sid, {
        store: host.store,
        autoCompact: async () => {
          await host.autoCompact(context);
        },
        claimNextStep: () => host.store.claimInbox(sid, 'next-step'),
        prepareView: (sess, msgs) => host.prepareMessagesForModel(sess, msgs),
        buildAppendix: async (sess, pack) => {
          const promptCtxInner: PromptContext = { ...context, session: sess };
          const query = pack?.query ?? '';
          const compiled = await host.promptBuilder.buildMemoryAppendix(promptCtxInner, {
            query,
            stateDir: host.stateDir
          });
          const reminder = buildSkillProposeReminder({
            settingsStore: host.store,
            turn,
            agent,
            session: sess
          });
          if (reminder) {
            void host.emitTrace(sid, { kind: 'skill_propose_reminder', payload: { turn } });
          }
          const withReminder = (text: string) =>
            reminder ? [text.trim(), reminder].filter(Boolean).join('\n\n') : text;
          if (compiled.trim()) return withReminder(compiled);
          return withReminder(readWorkingLogAppendix(host.stateDir, sid, process.env));
        },
        applyFoldBudget: (sess, foldedMsgs) => host.applyOptionalFoldBudget(sess, foldedMsgs)
      });
      context = { ...context, session: packed.session };
      const visibleMessages = packed.messages;
      const rawVisible = packed.viewMessages;
      await emitStep({
        type: 'turn_prepared',
        messages: visibleMessages,
        foldSeqs: packed.foldSeqs
      });
      const promptCtx: PromptContext = context;
      const drainedAdvisory = advisoryQueue.drainCombined();
      if (drainedAdvisory) {
        host.store.appendMessage(sid, 'system', [textPart(drainedAdvisory)]);
      }
      const systemPrompt = await host.promptBuilder.buildSystemPrompt(promptCtx, rawVisible);
      const stablePrefixHash = createHash('sha256')
        .update(host.promptBuilder.buildStablePrefix(promptCtx))
        .digest('hex')
        .slice(0, 16);
      const routing = host.promptBuilder.getRouting(sid);
      void host.emitTrace(sid, {
        kind: 'turn_start',
        payload: {
          turn,
          adapter: adapterOf(host.store.getSession(sid) ?? session).name,
          stablePrefixHash,
          routing: routing ? {
            mode: routing.mode,
            confidence: routing.confidence.level,
            shortlistCount: routing.shortlistNames.length,
            topSkill: routing.routed[0]?.skill.name
          } : undefined
        }
      });

      const resolveImageDataUrl = async (assetId: string, _sig?: AbortSignal) => {
        return host.resolveImageDataUrl(assetId, context.session.id);
      };

      const { dynHydrated, selectedTools } = await hydrateResolveTurnTools(
        host,
        context.session,
        agent,
        sid,
        queryForDynHydrate(visibleMessages),
        systemPrompt.length
      );
      emitDynHydrateTrace(host, sid, dynHydrated);
      const allowExternalAiTools = selectedTools.allowExternalAiTools;
      const turnTools = selectedTools.turnTools;
      host.turnShapeBySession.set(sid, selectedTools.turnShape);
      if (Object.keys(selectedTools.metadataPatch).length > 0) {
        host.mergeSessionMetadata(sid, selectedTools.metadataPatch);
        context = {
          ...context,
          session: host.store.getSession(sid) as SessionRecord
        };
      }
      if (selectedTools.drifted) {
        void host.emitTrace(sid, {
          kind: 'prompt_cache_bust',
          payload: { fingerprint: selectedTools.fingerprint, reason: 'toolset_drift' }
        });
      }

      if (turn === 0) {
        const startHook = await runLifecycleHook(process.env, {
          phase: 'session_start',
          sessionId: sid,
          context: { agentId: agent.id, mode: context.session.mode }
        });
        if (startHook.systemMessage || startHook.message) {
          host.store.appendMessage(sid, 'system', [
            textPart(startHook.systemMessage ?? startHook.message ?? '')
          ]);
        }
        const startExt = await host.extensionRegistry.run('session_start', {
          sessionId: sid,
          agentId: agent.id,
          meta: { mode: context.session.mode }
        });
        if (startExt.systemMessage || startExt.message) {
          host.store.appendMessage(sid, 'system', [
            textPart(startExt.systemMessage ?? startExt.message ?? '')
          ]);
        }
      }

      const beforeTurn = await host.extensionRegistry.run('before_turn', {
        sessionId: sid,
        agentId: agent.id,
        meta: { turn }
      });
      if (beforeTurn.block) {
        host.store.appendMessage(sid, 'system', [
          textPart(beforeTurn.message ?? beforeTurn.systemMessage ?? 'blocked by before_turn extension')
        ]);
        return await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'before_turn_blocked');
      }
      if (beforeTurn.systemMessage) {
        host.store.appendMessage(sid, 'system', [textPart(beforeTurn.systemMessage)]);
      }

      let turnInput = {
        agent,
        systemPrompt,
        messages: visibleMessages,
        tools: turnTools,
        signal,
        sessionId: sid,
        resolveImageDataUrl,
        promptCacheKey: selectedTools.promptCacheKey,
        ...(llmPromptDebugEnabled(process.env)
          ? { debugLlmContext: { stateDir: host.stateDir, sessionId: sid } }
          : {})
      };

      {
        const hasGoal = Boolean(goalGate?.isActive());
        const pre = await applyJevPreTurn(
          host.store,
          queryForDynHydrate(visibleMessages),
          hasGoal
        );
        if (pre === 'skip_done' && hasGoal) {
          host.store.appendMessage(sid, 'system', [
            textPart('[jev-pre-turn] Goal assumed met; skipping deep model turn.')
          ]);
          if (host.waitSteeringChildrenIdle) {
            await host.waitSteeringChildrenIdle(sid);
          } else {
            await waitSteeringChildrenIdle(sid);
          }
          return await host.handleTurnCompletion(session, agent, task).then((completed) =>
            finishEnded(completed, 'end')
          );
        }
      }

      let turnResult: ModelTurnResult;
      try {
        turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
      } catch (error) {
        // Degenerate repetition: the polluted partial was never persisted, so a
        // single clean retry is safe. A second hit means the model is stuck —
        // finalize gracefully instead of burning another full-tools prompt.
        if (isRepetitionAbort(error)) {
          void host.emitTrace(sid, {
            kind: 'repetition_abort',
            payload: { reason: error.reason, retry: true }
          });
          const repChoice = await applyJevRecoveryChoice(
            host.store,
            `repetition_abort:${error.reason}`,
            [
              { id: 'retry', label: 'Retry the model turn once with a clean stream' },
              { id: 'stop', label: 'Stop the run after repetition' }
            ]
          );
          if (repChoice === 'stop') {
            host.store.appendMessage(sid, 'system', [
              textPart(`[recovery] Stopped: model output degenerated into repetition (${error.reason})`)
            ]);
            return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'repetition');
          }
          try {
            turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
          } catch (retryError) {
            const reason = isRepetitionAbort(retryError) ? retryError.reason : error.reason;
            void host.emitTrace(sid, {
              kind: 'repetition_abort',
              payload: { reason, retry: false }
            });
            host.store.appendMessage(sid, 'system', [
              textPart(`[recovery] Stopped: model output degenerated into repetition (${reason})`)
            ]);
            return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'repetition');
          }
        } else if (isContextOverflowError(error)) {
          void host.emitTrace(sid, {
            kind: 'model_error',
            payload: { message: error instanceof Error ? error.message : String(error), overflow: true }
          });
          const compacted = await host.autoCompact(context, { force: true });
          if (compacted.replaced) {
            await emitStep({ type: 'compacted', replaced: compacted.replaced });
          }
          const packedRetry = await prepareTurnInput(sid, {
            store: host.store,
            autoCompact: async () => {},
            claimNextStep: () => host.store.claimInbox(sid, 'next-step'),
            prepareView: (sess, msgs) => host.prepareMessagesForModel(sess, msgs),
            buildAppendix: () => '',
            applyFoldBudget: (sess, foldedMsgs) => host.applyOptionalFoldBudget(sess, foldedMsgs)
          });
          turnInput = { ...turnInput, messages: packedRetry.messages };
          turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
        } else if (signal.aborted) {
          closeWaveIfOpen();
          return await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
        } else {
          void host.emitTrace(sid, {
            kind: 'model_error',
            payload: { message: error instanceof Error ? error.message : String(error) }
          });
          throw error;
        }
      }

      // Parsed tool_calls win over a false finish_reason=stop (DSML / gateway).
      // finishReason stays raw; only stopReason is corrected for the loop.
      {
        const parsedCalls = toolCallParts(turnResult.assistantParts).length;
        const corrected = resolveModelStopReason(turnResult.finishReason, parsedCalls);
        if (corrected === 'tool_use' && turnResult.stopReason !== 'tool_use' && parsedCalls > 0) {
          void host.emitTrace(sid, {
            kind: 'recovery_advisory',
            payload: {
              reason: 'wrong_stop_signal',
              trigger: 'wrong_stop_signal',
              finishReason: turnResult.finishReason,
              stopReason: turnResult.stopReason
            }
          });
          turnResult = { ...turnResult, stopReason: 'tool_use' };
        }
      }

      // Some gateways report prompt_tokens as a session running total. Left
      // as-is that would be summed again every turn, inflating totals and cost
      // quadratically. Normalize to this turn's share before anything consumes it.
      if (turnResult.usage) {
        const prev = host.cumulativeInputTokensBySession.get(sid);
        const split = splitCumulativePromptTokens(
          turnResult.usage.inputTokens,
          prev?.cumulative,
          prev?.sticky ?? false
        );
        host.cumulativeInputTokensBySession.set(sid, {
          cumulative: split.cumulativeInputTokens,
          // Once classified cumulative the session stays that way; see usage.ts.
          sticky: (prev?.sticky ?? false) || split.treatedAsCumulative
        });
        if (split.treatedAsCumulative) {
          const cached = Math.min(turnResult.usage.cachedInputTokens ?? 0, split.turnInputTokens);
          turnResult = {
            ...turnResult,
            usage: {
              ...turnResult.usage,
              inputTokens: split.turnInputTokens,
              totalTokens: split.turnInputTokens + turnResult.usage.outputTokens,
              ...(cached > 0 ? { cachedInputTokens: cached } : {})
            }
          };
          void host.emitTrace(sid, {
            kind: 'usage_cumulative_split',
            payload: {
              reportedInputTokens: split.cumulativeInputTokens,
              turnInputTokens: split.turnInputTokens
            }
          });
        }
      }

      let turnCostUsd: number | undefined;
      let turnCostModel: string | undefined;
      if (turnResult.usage) {
        try {
          const cost = estimateUsageCostUsd(
            turnResult.usage,
            process.env.RAW_AGENT_MODEL_NAME,
            process.env
          );
          turnCostUsd = cost.usd;
          turnCostModel = cost.model;
        } catch {
          /* ignore */
        }
      }

      void host.emitTrace(sid, {
        kind: 'turn_end',
        payload: {
          stopReason: turnResult.stopReason,
          ...(turnResult.finishReason ? { finishReason: turnResult.finishReason } : {}),
          ...(turnResult.usage ? { usage: turnResult.usage } : {}),
          ...(turnResult.truncated ? { truncated: true } : {}),
          ...(turnResult.requestId ? { requestId: turnResult.requestId } : {}),
          ...(turnCostUsd !== undefined ? { costUsd: turnCostUsd, costModel: turnCostModel } : {}),
          stableSystemVersion: STABLE_SYSTEM_VERSION
        }
      });

      // Truncation is a control-flow event (see decideTurnRecovery), not a clean end.
      if (turnResult.truncated) {
        void host.emitTrace(sid, {
          kind: 'turn_truncated',
          payload: {
            finishReason: turnResult.finishReason ?? 'length',
            ...(turnResult.usage ? { outputTokens: turnResult.usage.outputTokens } : {})
          }
        });
      }

      // Aggregate per-session token totals + USD cost estimate (best-effort).
      if (turnResult.usage) {
        try {
          const current = host.store.getSession(session.id);
          const prevTotals = (current?.metadata?.usageTotals ?? undefined) as
            | TokenUsage
            | undefined;
          const merged = mergeUsage(prevTotals, turnResult.usage);
          const prevCostUsd =
            typeof current?.metadata?.usageCostUsd === 'number'
              ? (current.metadata.usageCostUsd as number)
              : undefined;
          const usageCostUsd = mergeCostUsd(prevCostUsd, turnCostUsd);
          if (merged) {
            host.store.updateSession(session.id, {
              metadata: {
                ...(current?.metadata ?? {}),
                usageTotals: merged,
                ...(usageCostUsd !== undefined ? { usageCostUsd } : {})
              }
            });
          }
        } catch (err) {
          void err; // never let usage accounting break the turn
        }
      }

      let recovery = decideTurnRecovery({
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        truncated: turnResult.truncated,
        assistantParts: turnResult.assistantParts,
        state: recoveryState,
        userAborted: signal.aborted
      });
      if (recovery.action !== 'continue' || turnResult.truncated || turnResult.assistantParts.length === 0) {
        const recoveryOpts: Array<{ id: string; label: string }> = [
          { id: recovery.action, label: `Default: ${recovery.action}` }
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
        const chosen = await applyJevRecoveryChoice(
          host.store,
          `turn_recovery:${turnResult.stopReason}:${turnResult.finishReason ?? ''}`,
          recoveryOpts
        );
        if (chosen && chosen !== recovery.action) {
          if (chosen === 'continue') recovery = { action: 'continue' };
          else if (chosen === 'end') recovery = { action: 'end' };
          else if (chosen === 'retry-same-input') recovery = { action: 'retry-same-input' };
          else if (chosen === 'retry-after-nudge') {
            recovery = {
              action: 'retry-after-nudge',
              nudge:
                recovery.action === 'retry-after-nudge'
                  ? recovery.nudge
                  : '[recovery] Retry after Jev recovery choice.'
            };
          } else if (chosen === 'abort') {
            recovery = {
              action: 'abort',
              reason: recovery.action === 'abort' ? recovery.reason : 'jev_recovery_choice'
            };
          }
        }
      }
      if (discardedAssistant(recovery)) {
        void host.emitTrace(sid, {
          kind: 'recovery_advisory',
          payload: {
            reason: 'leaked_tool_call',
            trigger: 'leaked_tool_call',
            exhausted: recovery.action === 'abort',
            emptyRetries: recoveryState.emptyRetries,
            stopReason: turnResult.stopReason,
            ...(turnResult.finishReason ? { finishReason: turnResult.finishReason } : {})
          }
        });
      }
      if (recovery.action === 'abort' && recovery.reason === 'user_abort') {
        closeWaveIfOpen();
        return await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
      }
      if (recovery.action === 'retry-same-input') {
        host.store.appendMessage(sid, 'system', [
          textPart('[recovery] Truncated/incomplete tool_call discarded; retrying the same input.')
        ]);
        continue;
      }
      if (recovery.action === 'retry-after-nudge') {
        if (!recovery.discardAssistant && turnResult.assistantParts.length > 0) {
          host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
        }
        host.store.appendMessage(sid, 'system', [textPart(recovery.nudge)]);
        continue;
      }
      if (recovery.action === 'abort') {
        const reason = recovery.reason;
        host.store.appendMessage(sid, 'system', [
          textPart(
            reason === 'empty_assistant'
              ? '[recovery] Stopped: model returned no assistant content after retries.'
              : `[recovery] Stopped: ${reason}`
          )
        ]);
        void host.emitTrace(sid, {
          kind: 'recovery_abort',
          payload: { reason, trigger: 'turn_recovery' }
        });
        return await finishEnded(host.store.updateSession(session.id, { status: 'idle' }), reason);
      }

      if (turnResult.assistantParts.length === 0) {
        host.store.appendMessage(sid, 'system', [
          textPart('[recovery] Stopped: model returned no assistant content after retries.')
        ]);
        return await finishEnded(host.store.updateSession(session.id, { status: 'idle' }), 'empty_assistant');
      }

      // Reasoning spin: several turns in a row with only reasoning / empty output.
      // Deliberately no retry — a re-ask re-sends the full tool schemas for the
      // same non-answer. Persist what we got, explain, and finalize.
      const spinReason = spinWatchdog?.noteParts(turnResult.assistantParts);
      if (spinReason) {
        host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
        host.store.appendMessage(sid, 'system', [textPart(`[recovery] Stopped: ${spinReason}`)]);
        void host.emitTrace(sid, {
          kind: 'reasoning_spin_abort',
          payload: { reason: spinReason, streak: spinWatchdog!.streak }
        });
        return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'reasoning_spin');
      }

      let pendingRecoveryAdvisory: string | undefined;
      if (loopGuard) {
        const rep = loopGuard.checkAssistantRepetition(turnResult.assistantParts);
        const graceOut = advisoryGrace ? advisoryGrace.apply(rep) : rep.abort
          ? { action: 'abort' as const, reason: rep.reason }
          : { action: 'continue' as const };
        if (graceOut.action === 'advise') {
          const strike = noteCriticalHit(recoveryState);
          if (strike.action === 'abort') {
            host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
            host.store.appendMessage(session.id, 'system', [
              textPart(`[recovery] Stopped: ${graceOut.reason} (critical strike)`)
            ]);
            if (tryAutoFork('repetition-aborted')) continue;
            return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'repetition');
          }
          pendingRecoveryAdvisory = graceOut.advisory;
          void host.emitTrace(sid, {
            kind: 'recovery_advisory',
            payload: { reason: graceOut.reason, trigger: 'repetition' }
          });
        } else if (graceOut.action === 'abort') {
          host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
          await host.injectEvolvingCoachBeforeRecovery(session, agent, 'repetition', graceOut.reason);
          host.store.appendMessage(session.id, 'system', [textPart(`[recovery] Stopped: ${graceOut.reason}`)]);
          void host.emitTrace(sid, {
            kind: 'recovery_abort',
            payload: { reason: graceOut.reason, trigger: 'repetition' }
          });
          host.scheduleBackgroundCaseReview({
            sessionId: session.id,
            agentId: agent.id,
            outcome: 'failure',
            signals: { trigger: 'repetition', reason: graceOut.reason }
          });
          if (tryAutoFork('repetition-aborted')) continue;
          return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'repetition');
        }
      }

      const assistantMessage = host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
      if (pendingRecoveryAdvisory) {
        host.store.appendMessage(session.id, 'system', [textPart(pendingRecoveryAdvisory)]);
      }
      await emitStep({
        type: 'model_done',
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        truncated: turnResult.truncated,
        assistant: { parts: turnResult.assistantParts }
      });

      if (recovery.action !== 'continue') {
        const stopPhase = context.session.mode === 'subagent' ? 'subagent_stop' : 'stop';
        const stopHook = await runLifecycleHook(process.env, {
          phase: stopPhase,
          sessionId: sid,
          context: { stopReason: turnResult.stopReason, agentId: agent.id }
        });
        if (lifecycleBlocks(stopHook)) {
          host.store.appendMessage(sid, 'system', [
            textPart(
              `[stop-hook] ${stopHook.message ?? stopHook.systemMessage ?? 'stop blocked; continuing verification loop'}`
            )
          ]);
          continue;
        }
        if (stopHook.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(stopHook.systemMessage)]);
        }
        const stopExt = await host.extensionRegistry.run('stop', {
          sessionId: sid,
          agentId: agent.id,
          meta: { stopReason: turnResult.stopReason, mode: context.session.mode }
        });
        if (stopExt.block) {
          host.store.appendMessage(sid, 'system', [
            textPart(
              `[stop-extension] ${stopExt.message ?? stopExt.systemMessage ?? 'stop blocked; continuing'}`
            )
          ]);
          continue;
        }
        if (stopExt.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(stopExt.systemMessage)]);
        }

        // Soft-stop boundary: Jev route fan-out, then optional soft goal gate.
        // route.done only short-circuits deep-model judge when goalGate point is off.
        const softSnapshot = foldGoalJudgeSnapshot(host.store, sid);
        const route = await applyJevRoute(host.store, { state: softSnapshot, signal });
        if (route.kind === 'continue') {
          host.store.appendMessage(sid, 'system', [
            textPart(`[jev-route] ${route.reason}. Continue working.`)
          ]);
          continue;
        }
        if (goalGate?.isActive()) {
          if (route.kind === 'done') {
            host.store.appendMessage(sid, 'system', [
              textPart(`[jev-route] Achieved: ${route.reason}`)
            ]);
            void host.emitTrace(sid, {
              kind: 'goal_eval',
              payload: {
                met: true,
                reason: route.reason,
                source: 'jev-route',
                decision: 'achieved',
                turnsUsed: goalGate.getTurnsUsed()
              }
            });
          } else {
            const snapshot = softSnapshot;
            const gateAdapter = adapterOf(host.store.getSession(sid) ?? session);
            const fallbackJudge =
              typeof gateAdapter.completeText === 'function'
                ? (input: { system: string; user: string; signal?: AbortSignal }) =>
                    gateAdapter.completeText!({ ...input, jsonMode: true })
                : async () =>
                    JSON.stringify({ met: true, reason: 'no completeText; fail-open' });
            const judge = selectGoalJudge(host.store, fallbackJudge);
            const rec = goalStore?.findLatestBySession(sid);
            const verifySpec = rec?.spec.verify;
            const { evalResult, decision } = await goalGate.evaluate({
              snapshot,
              judge,
              signal,
              verify: verifySpec
                ? () =>
                    runGoalVerify(verifySpec, {
                      workspaceRoot: workspaceRoot ?? host.repoRoot,
                      settings: readGoalSettings({
                        getDaemonControl: <T>(key: string) =>
                          host.store.getDaemonControl?.(key) as T | undefined
                      }),
                      signal
                    })
                : undefined
            });
            host.mergeSessionMetadata(sid, goalGate.metadataPatch());
            if (goalStore) {
              persistGoalAfterEval({
                store: goalStore,
                sessionId: sid,
                metadata: host.store.getSession(sid)?.metadata ?? session.metadata,
                evalResult,
                decision,
                gate: goalGate
              });
            }
            void host.emitTrace(sid, {
              kind: 'goal_eval',
              payload: {
                met: evalResult.met,
                reason: evalResult.reason,
                source: evalResult.source,
                decision: decision.kind,
                turnsUsed: goalGate.getTurnsUsed()
              }
            });
            if (decision.kind === 'continue') {
              const reason =
                decision.unattendedInstruction ??
                `[goal] Condition not met yet: ${evalResult.reason}. Continue working toward the goal.`;
              host.store.appendMessage(sid, 'system', [textPart(reason)]);
              continue;
            }
            if (decision.kind === 'close') {
              host.store.appendMessage(sid, 'system', [
                textPart(`[goal] Closed (${decision.event}): ${decision.reason}`)
              ]);
            } else if (decision.kind === 'achieved') {
              host.store.appendMessage(sid, 'system', [
                textPart(`[goal] Achieved: ${evalResult.reason}`)
              ]);
            }
          }
        }

        saveClosedStep(turn, 'turn-end');
        if (host.waitSteeringChildrenIdle) {
          await host.waitSteeringChildrenIdle(sid);
        } else {
          await waitSteeringChildrenIdle(sid);
        }
        const steeredNow = host.store.claimInbox(sid, 'next-step');
        if (steeredNow.length > 0) {
          applyClaimedInbox(host.store, sid, steeredNow);
          continue;
        }
        return await host.handleTurnCompletion(session, agent, task).then((completed) =>
          finishEnded(completed, 'end')
        );
      }

      if (!assistantMessage) {
        return await finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'missing_assistant');
      }
      type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
      const toolCalls = assistantMessage.parts.filter(
        (part): part is ToolCallPart => part.type === 'tool_call'
      );

      const validToolCalls = host.filterValidToolCalls(
        toolCalls,
        allowExternalAiTools,
        session.id,
        turnTools
      );

      const closedByGate = { reported: false, ids: [] as string[] };
      const approvalResult = await host.checkToolApprovals(
        validToolCalls,
        context,
        filePolicy,
        session,
        turnTools,
        closedByGate
      );
      if (approvalResult === 'waiting') {
        if (validToolCalls.some((c) => c.name === 'ask_user')) {
          markGoalWaitingUser(goalStore, sid);
        }
        const approvalIds = host.store
          .listApprovals({ status: 'pending' })
          .filter((a) => a.sessionId === sid)
          .map((a) => a.id);
        const interrupt = createWaitingApprovalInterrupt({
          toolCallIds: validToolCalls.map((c) => c.toolCallId),
          approvalIds,
          writerRunId
        });
        const current = host.store.getSession(sid) as SessionRecord;
        const outcome = runOutcomeFromEnd({
          reason: 'waiting_approval',
          sessionStatus: 'waiting_approval'
        });
        const updated = host.store.updateSession(sid, {
          status: 'waiting_approval',
          metadata: mergeInterruptMetadata(
            mergeOutcomeMetadata(current.metadata ?? {}, outcome),
            interrupt
          )
        });
        await emitStep({ type: 'waiting_approval', approvalIds, interrupt });
        return updated;
      }
      if (approvalResult === 'skip') {
        continue;
      }

      const drainPolicy = resolveSteerDrainPolicy({
        option: options?.steerDrainPolicy,
        sessionMetadata: host.store.getSession(sid)?.metadata,
        store: host.store
      });
      const drain = drainSteerAtToolLaunch({
        store: host.store,
        sessionId: sid,
        toolCallIds: validToolCalls.map((c) => c.toolCallId),
        policy: drainPolicy
      });
      if (drain.drained) {
        await emitStep({
          type: 'tools_done',
          results: drain.skippedIds.map((id) => ({
            ok: false,
            content: TOOL_WAVE_SKIPPED_STEER_CONTENT,
            name: validToolCalls.find((c) => c.toolCallId === id)?.name
          }))
        });
        continue;
      }

      const executable = selectExecutableToolCalls(validToolCalls, closedByGate, () =>
        unmatchedToolCallsFromFold(
          host.store.foldMessages(sid),
          validToolCalls.map((call) => call.toolCallId)
        )
      );
      if (executable.length === 0) {
        continue;
      }

      const results = await host.executeToolCalls(
        executable,
        context,
        allowExternalAiTools,
        sid,
        turnTools
      );
      host.processToolResults(results, executable, session, task, sid, options?.onModelStreamChunk);
      recordDynToolUses(host, sid, turn, results, dynHydrated.names);
      await emitStep({
        type: 'tools_done',
        results: results.map((r) => ({ ok: r.ok, content: r.content, name: r.name }))
      });
      saveClosedStep(turn, 'step-end');

      if (riskEngine) {
        for (const r of results) {
          riskEngine.observeTool({
            toolName: r.name,
            success: r.ok,
            errorMessage: r.ok ? undefined : r.content
          });
        }
        const usageTotals = host.store.getSession(sid)?.metadata?.usageTotals as
          | TokenUsage
          | undefined;
        const budgetTokens = envInt(process.env, 'RAW_AGENT_TOKEN_BUDGET', 0);
        const tick = riskEngine.tick({
          iteration: turn,
          iterationLimit: maxTurnsPerRun,
          usedTokens: usageTotals?.totalTokens,
          budgetTokens: budgetTokens > 0 ? budgetTokens : undefined
        });
        if (tick.shouldAdvise) {
          const draft = advisoryQueue.enqueue(formatRiskAdvisory(tick.signals), 'risk');
          void host.emitTrace(sid, {
            kind: 'risk_advisory',
            payload: { reason: tick.reason, signals: tick.signals, advisoryId: draft.id }
          });
        }
      }

      if (loopGuard) {
        const ar = loopGuard.afterToolRound(
          validToolCalls.map((tc) => ({ name: tc.name, input: tc.input })),
          results.map((r) => ({ name: r.name, ok: r.ok }))
        );
        const graceOut = advisoryGrace ? advisoryGrace.apply(ar) : ar.abort
          ? { action: 'abort' as const, reason: ar.reason }
          : { action: 'continue' as const };
        if (graceOut.action === 'advise') {
          const strike = noteCriticalHit(recoveryState);
          if (strike.action === 'abort') {
            host.store.appendMessage(session.id, 'system', [
              textPart(`[recovery] Stopped: ${graceOut.reason} (critical strike)`)
            ]);
            if (tryAutoFork('deadloop-exhausted')) continue;
            return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'tool_loop');
          }
          host.store.appendMessage(session.id, 'system', [textPart(graceOut.advisory)]);
          void host.emitTrace(sid, {
            kind: 'recovery_advisory',
            payload: { reason: graceOut.reason, trigger: 'tools' }
          });
          continue;
        }
        if (graceOut.action === 'abort') {
          const fresh = host.store.getSession(session.id) as SessionRecord;
          await host.injectEvolvingCoachBeforeRecovery(fresh, agent, 'tools', graceOut.reason);
          host.store.appendMessage(session.id, 'system', [textPart(`[recovery] Stopped: ${graceOut.reason}`)]);
          void host.emitTrace(sid, {
            kind: 'recovery_abort',
            payload: { reason: graceOut.reason, trigger: 'tools' }
          });
          host.scheduleBackgroundCaseReview({
            sessionId: session.id,
            agentId: agent.id,
            outcome: 'failure',
            signals: { trigger: 'tools', reason: graceOut.reason }
          });
          if (tryAutoFork('deadloop-exhausted')) continue;
          return await finishFailed(host.store.updateSession(session.id, { status: 'idle' }), 'tool_loop');
        }
      }
    }

    host.scheduleBackgroundCaseReview({
      sessionId: session.id,
      agentId: agent.id,
      outcome: 'partial',
      signals: { reason: 'max_turns_exhausted', maxTurns: maxTurnsPerRun }
    });
    return await finishEnded(host.store.updateSession(session.id, { status: 'idle' }), 'max_turns');
  } catch (err) {
    if (host.store.isWriterCurrent && !host.store.isWriterCurrent(sid, writerRunId)) {
      host.emitTrace(sid, { kind: 'stale_writer_rejected', payload: { writerRunId } });
      return host.store.getSession(sid) ?? session;
    }
    const aborted = signal.aborted || (err instanceof Error && /session aborted/i.test(err.message));
    const reason = aborted ? 'abort' : err instanceof Error ? err.message : String(err);
    const rewind = rewindTail(reason);
    const current = host.store.getSession(sid);
    if (current) {
      persistOutcome(
        host.store.updateSession(sid, { status: 'failed' }),
        aborted ? 'abort' : 'model_error',
        rewind
      );
    }
    throw err;
  } finally {

    // Both per-session maps must outlive a single run (turn shape seeds the next
    // run's budget, cumulative tokens span turns), so they are pruned by size
    // rather than cleared here — a long-lived daemon would otherwise leak a
    // slot per session forever.
    capSessionMap(host.turnShapeBySession);
    capSessionMap(host.cumulativeInputTokensBySession);
  }
}

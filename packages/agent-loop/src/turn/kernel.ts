/**
 * L8: Turn kernel — one session run (prepare → model → recovery → tools).
 * Pure business logic; all I/O goes through TurnKernelHost.
 */

import { createId } from '../helpers.js';
import { NotFoundError } from '../errors.js';
import { ReasoningSpinWatchdog, RepetitionLoopAbortError } from '../streaming/index.js';
import { recoveryPolicyEnabled, SessionLoopGuard } from '../recovery/session-loop-guard.js';
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
  type RunInterruptState,
} from '../session/interrupt.js';
import { claimAndApplyInbox } from '../session/apply-claimed-inbox.js';
import { decideRewindTail, latestCheckpoint } from '../session/checkpoint.js';
import { clampFoldToVisible } from '../session/fold-budget.js';
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
import {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  type SteerDrainClaimStore,
  type SteerDrainPolicy,
} from '../session/steer-drain.js';
import {
  closeOpenToolWave,
  TOOL_WAVE_SKIPPED_STEER_CONTENT,
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
import type { AgentStepEvent, KernelStepInfo, TurnKernelHost } from './host.js';

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

// ============================================================================
// Main kernel
// ============================================================================

export async function runSessionKernel(
  host: TurnKernelHost,
  sessionId: string,
  options?: TurnKernelOptions
): Promise<SessionRecord> {
  let session = host.store.getSession(sessionId);
  if (!session) {
    throw new NotFoundError(`Session not found: ${sessionId}`);
  }

  // Resume-from-interrupt check
  const pendingApprovalIds = host.store
    .listApprovals({ status: 'pending' })
    .filter((a) => a.sessionId === sessionId)
    .map((a) => a.id);
  const resumeDecision = decideInterruptResume({ session, pendingApprovalIds });
  if (resumeDecision.action === 'yield_waiting') {
    await options?.latch?.emit({
      type: 'waiting_approval',
      approvalIds: resumeDecision.interrupt.approvalIds,
    });
    return session;
  }
  let resumeFromInterrupt: RunInterruptState | undefined =
    resumeDecision.action === 'resume_tools' ? resumeDecision.interrupt : undefined;

  const agent = host.store.getAgent(session.agentId);
  if (!agent) {
    throw new NotFoundError(`Agent not found: ${session.agentId}`);
  }

  const existingController = host.sessionAbortControllers?.get(sessionId);
  const controller = existingController ?? new AbortController();
  host.sessionAbortControllers?.set(sessionId, controller);
  const signal = controller.signal;
  const sid = session.id;
  const writerRunId = resumeFromInterrupt?.writerRunId ?? createId('run');
  host.store.claimWriter(sessionId, writerRunId);
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
  let sameToolStreak = 0;
  let lastToolRoundKey = '';

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
        const tokenBudget = resolveHistoryTokenBudget(
          'RAW_AGENT_COMPACT_TOKEN_THRESHOLD',
          { maxContextTokens: loopConfig.maxContextTokens ?? host.maxContextTokens },
          env
        );
        return clampFoldToVisible(foldedMsgs, {
          maxVisible: loopConfig.maxVisibleMessages,
          tokenBudget,
        });
      },
      readWorkingLogTail:
        skipMemory || !host.readWorkingLogAppendix
          ? undefined
          : (id) => host.readWorkingLogAppendix!(id),
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
    await host.ensureMcpLoaded?.(sid);
    const filePolicy = await host.resolveFilePolicy?.();
    session = host.store.updateSession(session.id, { status: 'running' });
    await host.ingestMailbox?.(session);
    await host.autoClaimTask?.(session);
    claimAndApplyInbox(host.store, sid, 'next-run', { expectedWriterRunId: writerRunId });

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (signal.aborted) {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
      }

      const refreshedSession = host.store.getSession(session.id) as SessionRecord;
      const task =
        host.resolveTask?.(refreshedSession) ??
        (refreshedSession.taskId ? host.store.getTask?.(refreshedSession.taskId) : undefined);
      const workspaceRoot = await host.ensureWorkspaceRoot?.(refreshedSession, task);
      const workspaceRoots =
        (await host.resolveWorkspaceRoots?.(refreshedSession)) ??
        defaultWorkspaceRoots(workspaceRoot, host.repoRoot);

      let context: RunContext = {
        repoRoot: host.repoRoot,
        stateDir: host.stateDir,
        session: refreshedSession,
        agent,
        workspaceRoot: workspaceRoot ?? host.repoRoot,
        workspaceRoots,
        abortSignal: signal,
      };

      // Resume from interrupt: claim next-step (user-interrupt) then remaining tools
      if (resumeFromInterrupt) {
        const interrupt = resumeFromInterrupt;
        resumeFromInterrupt = undefined;

        claimAndApplyInbox(host.store, sid, 'next-step', { expectedWriterRunId: writerRunId });

        const remaining = unmatchedToolCallsFromFold(
          host.store.foldMessages(sid),
          interrupt.toolCallIds.filter((id) => !interrupt.executedToolCallIds.includes(id))
        );

        if (remaining.length > 0) {
          const folded = host.store.foldMessages(sid);
          const picked = await pickTurnTools(context.session, folded, 0, false);
          const results = await host.executeToolCalls(
            remaining,
            context,
            picked.allowExternalAiTools,
            sessionId,
            picked.resolvedTools
          );
          host.processToolResults(results, remaining, context.session, undefined, sessionId, options?.onModelStreamChunk);
          for (const r of results) {
            host.recordToolUse?.({ name: r.name, sessionId: sid, turn, ok: r.ok });
          }
          await emitStep({
            type: 'tools_done',
            results: results.map((r) => ({ ok: r.ok, content: r.content, name: r.name })),
          });
        }

        host.store.updateSession(sid, {
          metadata: mergeInterruptMetadata(context.session.metadata ?? {}, null),
        });
        continue;
      }

      ensureFoldToolCallsPaired({
        foldMessages: () => host.store.foldMessages(sid),
        appendMessage: (role, parts) => host.store.appendMessage(sid, role, parts),
      });

      const packed = await packTurn({ workspaceRoot });
      context = { ...context, session: packed.session };
      const visibleMessages = packed.messages;
      const rawVisible = packed.viewMessages;

      await emitStep({
        type: 'turn_prepared',
        messageCount: visibleMessages.length,
        messages: visibleMessages,
        foldSeqs: packed.foldSeqs,
      });

      const promptCtx = {
        sessionId: sid,
        agent,
        session: context.session,
        workspaceRoot: workspaceRoot ?? host.repoRoot,
        repoRoot: host.repoRoot,
      };

      const drainedAdvisory = advisoryQueue.drainCombined();
      if (drainedAdvisory) {
        host.store.appendMessage(sid, 'system', [textPart(drainedAdvisory)]);
      }

      const systemPrompt = await host.promptBuilder.buildSystemPrompt(promptCtx, rawVisible);

      // ── session_start hook (turn 0 only) ────────────────────────────────
      if (turn === 0) {
        const startHook = await host.runLifecycleHook?.({
          phase: 'session_start',
          sessionId: sid,
          agentId: agent.id,
          turn: 0,
        });
        if (startHook?.block) {
          const msg = startHook.message ?? startHook.systemMessage ?? 'blocked by session_start hook';
          host.store.appendMessage(sid, 'system', [textPart(msg)]);
          return finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'session_start_blocked');
        }
        if (startHook?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(startHook.systemMessage)]);
        }
      }

      // ── before_turn hook (every turn) ───────────────────────────────────
      const beforeHook = await host.runLifecycleHook?.({
        phase: 'before_turn',
        sessionId: sid,
        agentId: agent.id,
        turn,
      });
      if (beforeHook?.block) {
        const msg = beforeHook.message ?? beforeHook.systemMessage ?? 'blocked by before_turn hook';
        host.store.appendMessage(sid, 'system', [textPart(msg)]);
        return finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'before_turn_blocked');
      }
      if (beforeHook?.systemMessage) {
        host.store.appendMessage(sid, 'system', [textPart(beforeHook.systemMessage)]);
      }

      const lastTurn = isLastAnswerTurn(turn, maxTurns, loopConfig.forceAnswerOnLastTurn);
      const picked = await pickTurnTools(
        context.session,
        visibleMessages,
        systemPrompt.length,
        lastTurn
      );
      const allowExternalAiTools = picked.allowExternalAiTools;
      const resolvedTools = picked.resolvedTools;
      const turnTools = picked.turnTools;
      const promptCacheKey = composePromptCacheKey([
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

      let turnInput = {
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

      const preTurn = await host.beforeModelTurn?.({
        session: context.session,
        messages: visibleMessages,
        hasPendingToolCalls: false,
      });
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
        return host.handleTurnCompletion(session, agent).then((completed) =>
          finishEnded(completed, 'end')
        );
      }

      let turnResult: ModelTurnResult;
      try {
        turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
      } catch (error) {
        if (error instanceof RepetitionLoopAbortError) {
          void host.emitTrace(sid, {
            kind: 'repetition_abort',
            data: { reason: error.reason, retry: true },
          });
          const repChoice = await maybeChooseRecovery(
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
            if (await tryAutoFork('repetition-aborted')) continue;
            return finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            );
          }
          try {
            turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
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
            if (await tryAutoFork('repetition-aborted')) continue;
            return finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            );
          }
        } else if (isContextOverflowError(error)) {
          void host.emitTrace(sid, {
            kind: 'model_error',
            data: {
              message: error instanceof Error ? error.message : String(error),
              overflow: true,
            },
          });
          const compacted = await host.autoCompact(context, { force: true });
          if (compacted.replaced) {
            await emitStep({ type: 'compacted', replaced: compacted.replaced });
          }
          const packedRetry = loopConfig.overflowReprepare
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
          turnResult = await host.runTurnWithRetries(turnInput, options?.onModelStreamChunk);
        } else if (signal.aborted) {
          closeWaveIfOpen();
          await rollbackOpenStep('abort');
          return finishFailed(
            host.store.updateSession(session.id, { status: 'failed' }),
            'abort'
          );
        } else {
          const err = error instanceof Error ? error : new Error(String(error));
          const pending = unmatchedToolCallsFromFold(host.store.foldMessages(sid));
          const recovered = await recoverFromModelBehavior({
            error: err,
            pending: pending.map((p) => ({ toolCallId: p.toolCallId, name: p.name })),
            currentToolNames: resolvedTools.map((t) => t.name),
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
            continue;
          }
          void host.emitTrace(sid, {
            kind: 'model_error',
            data: { message: err.message },
          });
          const txReason = rollbackReasonOf({ runError: err.message });
          if (txReason) await rollbackOpenStep(txReason);
          throw error;
        }
      }

      const promoted = promoteAssistantReasoning(turnResult.assistantParts);
      if (promoted.promoted) {
        turnResult = { ...turnResult, assistantParts: promoted.parts };
      }
      if (lastTurn) {
        const hadCalls = turnResult.assistantParts.some((p) => p.type === 'tool_call');
        const withoutCalls = turnResult.assistantParts.filter((p) => p.type !== 'tool_call');
        const hasText = withoutCalls.some((p) => p.type === 'text' && p.text.trim());
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

      const stopFix = correctWrongStopSignal({
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

      if (turnResult.usage) {
        const prev = usageBySession.get(sid);
        const split = splitCumulativePromptTokens(
          turnResult.usage.inputTokens,
          prev?.cumulative,
          prev?.sticky ?? false
        );
        usageBySession.set(sid, {
          cumulative: split.cumulativeInputTokens,
          sticky: (prev?.sticky ?? false) || split.treatedAsCumulative,
        });
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
      }

      let turnCostUsd: number | undefined;
      let turnCostModel: string | undefined;
      if (turnResult.usage) {
        try {
          const cost = estimateUsageCostUsd(turnResult.usage, loopConfig.modelName);
          turnCostUsd = cost.usd;
          turnCostModel = cost.model;
        } catch {
          /* ignore */
        }
      }

      void host.emitTrace(sid, {
        kind: 'turn_end',
        data: {
          stopReason: turnResult.stopReason,
          ...(turnResult.finishReason ? { finishReason: turnResult.finishReason } : {}),
          ...(turnResult.usage ? { usage: turnResult.usage } : {}),
          ...(turnResult.truncated ? { truncated: true } : {}),
          ...(turnResult.requestId ? { requestId: turnResult.requestId } : {}),
          ...(turnCostUsd !== undefined ? { costUsd: turnCostUsd, costModel: turnCostModel } : {}),
        },
      });
      if (turnResult.truncated) {
        void host.emitTrace(sid, {
          kind: 'turn_truncated',
          data: {
            finishReason: turnResult.finishReason ?? 'length',
            ...(turnResult.usage ? { outputTokens: turnResult.usage.outputTokens } : {}),
          },
        });
      }
      if (turnResult.usage) {
        try {
          const current = host.store.getSession(session.id);
          const prevTotals = (current?.metadata?.usageTotals ?? undefined) as TokenUsage | undefined;
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
                ...(usageCostUsd !== undefined ? { usageCostUsd } : {}),
              },
            });
          }
        } catch {
          // never let usage accounting break the turn
        }
      }

      let recovery = decideTurnRecovery({
        stopReason: turnResult.stopReason,
        finishReason: turnResult.finishReason,
        truncated: turnResult.truncated,
        assistantParts: turnResult.assistantParts,
        state: recoveryState,
        userAborted: signal.aborted,
      });
      if (recovery.action !== 'continue' || turnResult.truncated || turnResult.assistantParts.length === 0) {
        const recoveryOpts: Array<{ id: string; label: string }> = [
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
        const chosen = await maybeChooseRecovery(
          `turn_recovery:${turnResult.stopReason}:${turnResult.finishReason ?? ''}`,
          recoveryOpts,
          recovery.action
        );
        if (chosen !== recovery.action) {
          if (chosen === 'continue') recovery = { action: 'continue' };
          else if (chosen === 'end') recovery = { action: 'end' };
          else if (chosen === 'retry-same-input') recovery = { action: 'retry-same-input' };
          else if (chosen === 'retry-after-nudge') {
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
        }
      }

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
        return finishFailed(
          host.store.updateSession(session.id, { status: 'failed' }),
          'abort'
        );
      }
      if (recovery.action === 'retry-same-input') {
        host.store.appendMessage(sid, 'system', [
          textPart(
            '[recovery] Truncated/incomplete tool_call discarded; retrying the same input.'
          ),
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
          ),
        ]);
        void host.emitTrace(sid, {
          kind: 'recovery_abort',
          data: { reason, trigger: 'turn_recovery' },
        });
        return finishEnded(host.store.updateSession(session.id, { status: 'idle' }), reason);
      }

      if (turnResult.assistantParts.length === 0) {
        host.store.appendMessage(sid, 'system', [
          textPart(
            '[recovery] Stopped: model returned no assistant content after retries.'
          ),
        ]);
        return finishEnded(
          host.store.updateSession(session.id, { status: 'idle' }),
          'empty_assistant'
        );
      }

      const spinReason = spinWatchdog?.noteParts(turnResult.assistantParts);
      if (spinReason) {
        host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
        host.store.appendMessage(sid, 'system', [textPart(`[recovery] Stopped: ${spinReason}`)]);
        void host.emitTrace(sid, {
          kind: 'reasoning_spin_abort',
          data: { reason: spinReason, streak: spinWatchdog?.streak },
        });
        return finishFailed(
          host.store.updateSession(session.id, { status: 'idle' }),
          'reasoning_spin'
        );
      }

      // Repetition guard (assistant output)
      let pendingRecoveryAdvisory: string | undefined;
      const rep = loopGuard?.checkAssistantRepetition(turnResult.assistantParts) ?? { abort: false as const };
      const graceOut = advisoryGrace.apply(rep);
      if (graceOut.action === 'advise' || graceOut.action === 'abort') {
        const guardChoice = await maybeChooseRecovery(
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
          if (await tryAutoFork('repetition-aborted')) continue;
          return finishFailed(
            host.store.updateSession(session.id, { status: 'idle' }),
            'repetition'
          );
        }
        if (guardChoice === 'advise') {
          const strike = noteCriticalHit(recoveryState);
          if (strike.action === 'abort') {
            host.store.appendMessage(session.id, 'assistant', turnResult.assistantParts);
            host.store.appendMessage(session.id, 'system', [
              textPart(`[recovery] Stopped: ${graceOut.reason} (critical strike)`),
            ]);
            if (await tryAutoFork('repetition-aborted')) continue;
            return finishFailed(
              host.store.updateSession(session.id, { status: 'idle' }),
              'repetition'
            );
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
        // guardChoice === 'continue' → fall through
      }

      const modelStep = stepInfo(turn, 'model_done');
      await host.stepTx?.beginStep?.(modelStep);
      const assistantMessage = host.store.appendMessage(
        session.id,
        'assistant',
        turnResult.assistantParts
      );
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

      // Clean end — no tool calls requested
      if (recovery.action !== 'continue') {
        const stopPhase = context.session.mode === 'subagent' ? 'subagent_stop' : 'stop';
        const stopHook = await host.runLifecycleHook?.({
          phase: stopPhase,
          sessionId: sid,
          agentId: agent.id,
          meta: { stopReason: turnResult.stopReason },
        });
        if (stopHook?.block) {
          const msg = stopHook.message ?? stopHook.systemMessage ?? 'stop blocked; continuing';
          host.store.appendMessage(sid, 'system', [textPart(`[stop-hook] ${msg}`)]);
          continue;
        }
        if (stopHook?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(stopHook.systemMessage)]);
        }

        const goal = await host.evaluateGoalGate?.({
          session,
          agent,
          signal,
          workspaceRoot: workspaceRoot ?? host.repoRoot,
        });
        if (goal?.systemMessage) {
          host.store.appendMessage(sid, 'system', [textPart(goal.systemMessage)]);
        } else if (goal && !goal.met) {
          host.store.appendMessage(sid, 'system', [
            textPart(`[goal] not yet met: ${goal.reason ?? 'continuing'}`),
          ]);
        }
        if (goal && (!goal.met || goal.action === 'continue')) {
          continue;
        }

        // ── steering: wait for child sessions before soft completion ───────
        if (host.waitSteeringChildrenIdle) {
          await host.waitSteeringChildrenIdle(sid);
        }

        host.onSessionOutcome?.({
          sessionId: session.id,
          agentId: agent.id,
          outcome: 'success',
        });

        return host.handleTurnCompletion(session, agent).then((completed) =>
          finishEnded(completed, 'end')
        );
      }

      // Extract tool calls
      type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;
      const rawToolCalls = assistantMessage.parts.filter(
        (part): part is ToolCallPart => part.type === 'tool_call'
      );
      const toolCalls = host.filterValidToolCalls
        ? host.filterValidToolCalls(rawToolCalls, allowExternalAiTools, sid, resolvedTools)
        : rawToolCalls;

      if (toolCalls.length === 0) {
        continue;
      }

      if (signal.aborted) {
        closeWaveIfOpen();
        await rollbackOpenStep('abort');
        return finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
      }

      const approvalResult =
        (await host.checkToolApprovals?.(toolCalls, context, session, {
          filePolicy,
          turnTools: resolvedTools,
        })) ?? 'proceed';
      const hostLatch = loopConfig.hitlLatch
        ? await host.shouldLatchBeforeTools?.({ session, toolCalls })
        : undefined;
      const latch = decideHitlLatch({
        aborted: signal.aborted,
        approval: approvalResult,
        hostLatch,
      });

      const parkForApproval = async () => {
        host.noteGoalWaitingUser?.(sid, toolCalls);
        const approvalIds = host.store
          .listApprovals({ status: 'pending' })
          .filter((a) => a.sessionId === sid)
          .map((a) => a.id);
        const interrupt = createWaitingApprovalInterrupt({
          toolCallIds: toolCalls.map((c) => c.toolCallId),
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
        return finishFailed(host.store.updateSession(session.id, { status: 'failed' }), 'abort');
      }
      if (latch.action === 'waiting') {
        return parkForApproval();
      }
      if (latch.action === 'skip') {
        continue;
      }
      if (latch.action === 'steer') {
        closeWaveIfOpen();
        return finishEnded(host.store.updateSession(session.id, { status: 'idle' }), 'steering');
      }

      const drainPolicy = resolveSteerDrainPolicy({
        option: options?.steerDrainPolicy,
        sessionMetadata: host.store.getSession(sid)?.metadata,
        store: host.store,
      });
      if (typeof host.store.claimInbox === 'function' && typeof host.store.hideByKey === 'function') {
        const drain = drainSteerAtToolLaunch({
          store: host.store as unknown as SteerDrainClaimStore,
          sessionId: sid,
          toolCallIds: toolCalls.map((c) => c.toolCallId),
          policy: drainPolicy,
          expectedWriterRunId: writerRunId,
        });
        if (drain.drained) {
          await emitStep({
            type: 'tools_done',
            results: drain.skippedIds.map((id) => ({
              ok: false,
              content: TOOL_WAVE_SKIPPED_STEER_CONTENT,
              name: toolCalls.find((c) => c.toolCallId === id)?.name,
            })),
          });
          continue;
        }
      }

      const toolsStep = stepInfo(turn, 'tools_done');
      await host.stepTx?.beginStep?.(toolsStep);
      const results = await host.executeToolCalls(
        toolCalls,
        context,
        allowExternalAiTools,
        sid,
        resolvedTools
      );
      host.processToolResults(results, toolCalls, context.session, undefined, sid, options?.onModelStreamChunk);
      for (const r of results) {
        host.recordToolUse?.({ name: r.name, sessionId: sid, turn, ok: r.ok });
      }

      await emitStep({
        type: 'tools_done',
        results: results.map((r) => ({ ok: r.ok, content: r.content, name: r.name })),
      });
      await host.stepTx?.commitStep?.(toolsStep);

      if (stopAt.size > 0) {
        const hit = results.find((r) => r.ok && stopAt.has(r.name));
        if (hit) {
          return finishEnded(
            host.store.updateSession(session.id, { status: 'idle' }),
            `stop_at:${hit.name}`
          );
        }
      }

      // Risk engine
      const toolRoundKey = toolCalls
        .map((tc) => `${tc.name}:${JSON.stringify(tc.input ?? {})}`)
        .join('|');
      sameToolStreak = toolRoundKey === lastToolRoundKey ? sameToolStreak + 1 : 1;
      lastToolRoundKey = toolRoundKey;
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
          sameToolStreak,
          sameToolThreshold: loopGuard?.sameToolThreshold ?? 5,
        });
        if (tick.shouldAdvise) {
          const draft = advisoryQueue.enqueue(formatRiskAdvisory(tick.signals), 'risk');
          void host.emitTrace(sid, {
            kind: 'risk_advisory',
            data: { reason: tick.reason, signals: tick.signals, advisoryId: draft.id },
          });
        }
      }

      // Loop guard after tool round
      const toolRep = loopGuard?.afterToolRound(
        toolCalls.map((tc) => ({ name: tc.name, input: tc.input })),
        results.map((r) => ({ name: r.name, ok: r.ok }))
      ) ?? { abort: false as const };
      const toolRepDecision: { abort: boolean; reason: string } = toolRep.abort
        ? { abort: true, reason: toolRep.reason }
        : { abort: false, reason: '' };
      const toolGraceOut = advisoryGrace.apply(toolRepDecision);
      if (toolGraceOut.action === 'advise') {
        const strike = noteCriticalHit(recoveryState);
        if (strike.action === 'abort') {
          host.store.appendMessage(session.id, 'system', [
            textPart(`[recovery] Stopped: ${toolGraceOut.reason} (critical strike)`),
          ]);
          if (await tryAutoFork('deadloop-exhausted')) continue;
          return finishFailed(
            host.store.updateSession(session.id, { status: 'idle' }),
            'tool_loop'
          );
        }
        host.store.appendMessage(session.id, 'system', [textPart(toolGraceOut.advisory)]);
        void host.emitTrace(sid, {
          kind: 'recovery_advisory',
          data: { reason: toolGraceOut.reason, trigger: 'tools' },
        });
        continue;
      }
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
        if (await tryAutoFork('deadloop-exhausted')) continue;
        return finishFailed(
          host.store.updateSession(session.id, { status: 'idle' }),
          'tool_loop'
        );
      }
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
    return finishEnded(
      host.store.updateSession(session.id, { status: 'idle' }),
      'max_turns'
    );
  } catch (err) {
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
    throw err;
  } finally {
    host.sessionAbortControllers?.delete(sessionId);
    const current = host.store.getSession(sessionId);
    if (current?.status !== 'waiting_approval') {
      host.store.releaseWriter(sessionId, writerRunId);
    }
  }
}

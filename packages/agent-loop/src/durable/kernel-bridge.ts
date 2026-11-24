/**
 * Durable Kernel Bridge — manages durable_runs lifecycle, restart-limit circuit
 * breaker, and KernelCheckpointState persistence/restoration for TurnKernel.
 * Zero Node I/O (mini-safe), every helper kept at CC <= 5.
 */

import { createInitialDurableKernelState } from './step-helpers.js';
import type {
  DurableJournalPort,
  DurableRunRecord,
  DurableRunStatus,
  KernelCheckpointState,
  ToolParkDirective,
  WaveRollbackPolicy,
} from './types.js';

export interface DurableKernelConfig {
  journal: DurableJournalPort;
  restartLimit: number;
  parentRunId?: string;
  waveRollbackPolicy?: WaveRollbackPolicy;
}

export interface DurableRunSession {
  run: DurableRunRecord;
  resumed: boolean;
  blockedByRestartLimit: boolean;
  startTurn: number;
  startStepCursor: number;
  restoredState: KernelCheckpointState;
  checkpoint(state: KernelCheckpointState): void;
  finish(status: DurableRunStatus, errorText?: string): void;
}

export interface RestorableKernelGuards {
  advisoryGrace: { restoreUsedCount(used: number): void; usedCount: number };
  advisoryQueue: { enqueue(text: string, source: 'risk' | 'recovery' | 'evolving' | 'goal'): unknown; peek(): Array<{ text: string }> };
  spinWatchdog: { restoreStreak(n: number): void; streak: number } | null;
  progressGuard: { restoreCounters(input: { sameToolStreak?: number }): void; sameToolStreak: number; totalFailureCount: number };
}

export function restoreDurableKernelGuards(
  session: DurableRunSession | undefined,
  guards: RestorableKernelGuards,
  usageBySession: Map<string, { cumulative: number; sticky: boolean }>,
  sessionId: string
): void {
  if (!session?.resumed) return;
  const s = session.restoredState;
  guards.advisoryGrace.restoreUsedCount(s.advisoryGraceUsed);
  for (const adv of s.pendingAdvisories) guards.advisoryQueue.enqueue(adv, 'recovery');
  guards.spinWatchdog?.restoreStreak(s.spinNoProgressStreak);
  guards.progressGuard.restoreCounters({ sameToolStreak: s.sameToolStreak });
  if (s.cumulativeInputTokens > 0) {
    usageBySession.set(sessionId, { cumulative: s.cumulativeInputTokens, sticky: false });
  }
}

export function snapshotDurableKernelState(input: {
  turn: number;
  stepCursor: number;
  guards: RestorableKernelGuards;
  usageBySession: Map<string, { cumulative: number; sticky: boolean }>;
  sessionId: string;
}): KernelCheckpointState {
  return {
    turn: input.turn,
    stepCursor: input.stepCursor,
    advisoryGraceUsed: input.guards.advisoryGrace.usedCount,
    pendingAdvisories: input.guards.advisoryQueue.peek().map((d) => d.text),
    spinNoProgressStreak: input.guards.spinWatchdog?.streak ?? 0,
    cumulativeInputTokens: input.usageBySession.get(input.sessionId)?.cumulative ?? 0,
    sameToolStreak: input.guards.progressGuard.sameToolStreak,
    loopFailureCount: input.guards.progressGuard.totalFailureCount,
    riskScore: 0,
  };
}

export function firstParkedToolResult(
  results: readonly { toolCallId: string; name: string; park?: ToolParkDirective }[]
): { toolCallId: string; name: string; park: ToolParkDirective } | undefined {
  for (const r of results) {
    if (r.park) return { toolCallId: r.toolCallId, name: r.name, park: r.park };
  }
  return undefined;
}

export function findOpenDurableToolCalls(
  folded: readonly { parts: readonly { type: string; toolCallId?: string; name?: string; input?: Record<string, unknown> }[] }[]
): Array<{ toolCallId: string; name: string; input: Record<string, unknown> }> {
  const closed = new Set<string>();
  const pending = new Map<string, { toolCallId: string; name: string; input: Record<string, unknown> }>();
  for (const msg of folded) {
    for (const part of msg.parts) {
      if (part.type === 'tool_call' && typeof part.toolCallId === 'string' && typeof part.name === 'string') {
        closed.delete(part.toolCallId);
        pending.set(part.toolCallId, {
          toolCallId: part.toolCallId,
          name: part.name,
          input: (part.input ?? {}) as Record<string, unknown>,
        });
      } else if (part.type === 'tool_result' && typeof part.toolCallId === 'string') {
        closed.add(part.toolCallId);
        pending.delete(part.toolCallId);
      }
    }
  }
  return [...pending.values()].filter((c) => !closed.has(c.toolCallId));
}

function findResumableRun(journal: DurableJournalPort, sessionId: string): DurableRunRecord | undefined {
  const latest = journal.getLatestRunForSession(sessionId);
  if (!latest) return undefined;
  if (latest.status === 'resumable' || latest.status === 'suspended_interrupted' || latest.status === 'waiting_park') {
    return latest;
  }
  return undefined;
}

export function startOrResumeDurableRun(input: {
  config: DurableKernelConfig;
  sessionId: string;
  writerRunId: string;
}): DurableRunSession {
  const { journal, restartLimit, parentRunId } = input.config;
  const resumable = findResumableRun(journal, input.sessionId);

  if (resumable && resumable.restarts >= restartLimit) {
    const failed = journal.updateRun(resumable.runId, {
      status: 'failed',
      errorText: `restart_limit (${resumable.restarts}/${restartLimit})`,
    });
    return makeSession(journal, failed, true, true);
  }

  const run = resumable
    ? journal.updateRun(resumable.runId, {
        status: 'running',
        fencingEpoch: resumable.fencingEpoch + 1,
      })
    : journal.beginRun({
        runId: input.writerRunId,
        sessionId: input.sessionId,
        parentRunId,
        kernelState: createInitialDurableKernelState(),
      });

  return makeSession(journal, run, Boolean(resumable), false);
}

function makeSession(
  journal: DurableJournalPort,
  run: DurableRunRecord,
  resumed: boolean,
  blockedByRestartLimit: boolean
): DurableRunSession {
  const restored = { ...run.kernelState, pendingAdvisories: [...run.kernelState.pendingAdvisories] };
  return {
    run,
    resumed,
    blockedByRestartLimit,
    startTurn: resumed ? restored.turn : 0,
    startStepCursor: resumed ? restored.stepCursor : 0,
    restoredState: restored,
    checkpoint(state: KernelCheckpointState) {
      try {
        journal.updateRun(run.runId, { kernelState: state, restarts: 0 });
      } catch {
        /* fail-soft so persistence glitches never corrupt live turn */
      }
    },
    finish(status: DurableRunStatus, errorText?: string) {
      try {
        const current = journal.getRun(run.runId);
        if (!current) return;
        if (current.status === 'waiting_park' && status === 'completed') return;
        journal.updateRun(run.runId, {
          status,
          ...(errorText !== undefined ? { errorText } : {}),
        });
      } catch {
        /* fail-soft */
      }
    },
  };
}

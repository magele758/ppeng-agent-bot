/**
 * Unified Park / Signal wakeup, Cancel, and Unknown-Step Reconcile primitives.
 * Zero Node I/O (mini-safe). Every helper kept at CC <= 5.
 */

import type { RunContext, ToolContract } from '../types.js';
import type {
  DurableJournalPort,
  DurableSignalRecord,
  DurableStepRecord,
  ToolParkSignalRef,
} from './types.js';

export interface ParkWakeMatch {
  ready: boolean;
  reason?: 'signal' | 'deadline';
  signal?: DurableSignalRecord;
}

function findMatchingPendingSignal(
  journal: DurableJournalPort,
  runId: string,
  stepId: string,
  signals: readonly ToolParkSignalRef[] | undefined
): DurableSignalRecord | undefined {
  if (!signals?.length) return undefined;
  for (const ref of signals) {
    const rec = journal.readSignal(runId, stepId, ref.name, ref.key);
    if (rec && rec.state === 'pending') return rec;
  }
  return undefined;
}

/**
 * Checks whether a parked step is ready to wake (either a required signal is
 * pending — including early signals — or `untilMs` has elapsed).
 */
export function checkParkedStepWake(
  journal: DurableJournalPort,
  step: DurableStepRecord,
  nowMs = Date.now()
): ParkWakeMatch {
  if (step.phase !== 'parked' || !step.park) return { ready: false };
  const sig = findMatchingPendingSignal(journal, step.runId, step.stepId, step.park.signals);
  if (sig) return { ready: true, reason: 'signal', signal: sig };
  if (typeof step.park.untilMs === 'number' && nowMs >= step.park.untilMs) {
    return { ready: true, reason: 'deadline' };
  }
  return { ready: false };
}

/**
 * Wakes any ready parked steps on a `waiting_park` run, consuming matching signals
 * exactly once and transitioning the run to `resumable`.
 */
export function wakeReadyParkedRun(
  journal: DurableJournalPort,
  runId: string,
  nowMs = Date.now()
): { woke: boolean; wokeStepIds: string[]; consumedSignals: DurableSignalRecord[] } {
  const steps = journal.listSteps(runId);
  const wokeStepIds: string[] = [];
  const consumedSignals: DurableSignalRecord[] = [];
  for (const step of steps) {
    const match = checkParkedStepWake(journal, step, nowMs);
    if (!match.ready) continue;
    if (match.signal) {
      const consumed = journal.consumeSignal(runId, step.stepId, match.signal.signalName, match.signal.signalKey);
      if (consumed) consumedSignals.push(consumed);
    }
    journal.updateStepPhase(step.stepId, 'planned');
    wokeStepIds.push(step.stepId);
  }
  if (wokeStepIds.length > 0) {
    journal.updateRun(runId, { status: 'resumable' });
  }
  return { woke: wokeStepIds.length > 0, wokeStepIds, consumedSignals };
}

/**
 * Cancels all parked steps for an aborted run by invoking each tool's idempotent
 * `cancel(ctx, checkpoint)` hook (best-effort) and expiring pending signals.
 */
export async function cancelParkedStepsForRun(input: {
  journal: DurableJournalPort;
  runId: string;
  tools: readonly ToolContract<any>[];
  buildContext: (step: DurableStepRecord) => RunContext;
}): Promise<{ cancelledStepIds: string[]; expiredSignals: number }> {
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const cancelledStepIds: string[] = [];
  let expiredSignals = 0;
  for (const step of input.journal.listSteps(input.runId)) {
    if (step.phase !== 'parked') continue;
    const tool = step.toolName ? byName.get(step.toolName) : undefined;
    if (tool?.cancel) {
      try {
        await tool.cancel(input.buildContext(step), step.park?.checkpoint);
      } catch {
        /* cancel hooks are fail-soft during abort */
      }
    }
    expiredSignals += input.journal.expireSignals(input.runId, step.stepId);
    input.journal.failStep(step.stepId, 'aborted_while_parked');
    cancelledStepIds.push(step.stepId);
  }
  return { cancelledStepIds, expiredSignals };
}

export interface ReconcileStepsOutcome {
  committedStepIds: string[];
  notAppliedStepIds: string[];
  unresolvedStepIds: string[];
}

/**
 * Runs `tool.reconcile(ctx, intent)` probes on all `unknown` steps of a run.
 * Converges confirmed steps to `committed` or `failed` (`not_applied`), and
 * flags unconfirmed unsafe steps for operator `needs_reconcile`.
 */
export async function reconcileUnknownStepsForRun(input: {
  journal: DurableJournalPort;
  runId: string;
  tools: readonly ToolContract<any>[];
  buildContext: (step: DurableStepRecord) => RunContext;
  argsForStep?: (step: DurableStepRecord) => Record<string, unknown>;
  persistReconciledResult?: (step: DurableStepRecord, res: { ok: boolean; content: string }) => number | undefined;
}): Promise<ReconcileStepsOutcome> {
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const committedStepIds: string[] = [];
  const notAppliedStepIds: string[] = [];
  const unresolvedStepIds: string[] = [];

  for (const step of input.journal.listSteps(input.runId)) {
    if (step.phase !== 'unknown') continue;
    const tool = step.toolName ? byName.get(step.toolName) : undefined;
    if (!tool?.reconcile) {
      if (step.replayPolicy === 'unsafe') unresolvedStepIds.push(step.stepId);
      continue;
    }
    const probe = await runSingleReconcileProbe(tool, step, input);
    if (probe === 'committed') committedStepIds.push(step.stepId);
    else if (probe === 'not_applied') notAppliedStepIds.push(step.stepId);
    else unresolvedStepIds.push(step.stepId);
  }

  if (unresolvedStepIds.length > 0) {
    input.journal.updateRun(input.runId, { status: 'needs_reconcile' });
  }
  return { committedStepIds, notAppliedStepIds, unresolvedStepIds };
}

async function runSingleReconcileProbe(
  tool: ToolContract<any>,
  step: DurableStepRecord,
  input: {
    journal: DurableJournalPort;
    buildContext: (step: DurableStepRecord) => RunContext;
    argsForStep?: (step: DurableStepRecord) => Record<string, unknown>;
    persistReconciledResult?: (step: DurableStepRecord, res: { ok: boolean; content: string }) => number | undefined;
  }
): Promise<'committed' | 'not_applied' | 'unknown'> {
  try {
    const outcome = await tool.reconcile!(input.buildContext(step), {
      idempotencyKey: step.idempotencyKey,
      args: input.argsForStep?.(step) ?? {},
      startedAt: step.startedAt ?? step.createdAt,
    });
    if (outcome.status === 'committed') {
      const seq = input.persistReconciledResult?.(step, {
        ok: outcome.ok !== false,
        content: outcome.content ?? '[reconciled] side effect confirmed applied',
      });
      input.journal.commitStep(step.stepId, { messageSeq: seq, receipt: outcome.receipt });
      return 'committed';
    }
    if (outcome.status === 'not_applied') {
      const seq = input.persistReconciledResult?.(step, {
        ok: false,
        content: outcome.content ?? '[reconciled] side effect confirmed not applied',
      });
      input.journal.failStep(step.stepId, 'reconciled_not_applied', { messageSeq: seq });
      return 'not_applied';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

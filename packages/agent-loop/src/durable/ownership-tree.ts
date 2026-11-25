/**
 * Durable Ownership Tree — bottom-up `completing` cascade cancellation and
 * boot-time orphan child abandonment for subagent hierarchies.
 * Zero Node I/O (mini-safe), every helper kept at CC <= 5.
 */

import type { DurableJournalPort, DurableRunRecord, DurableRunStatus } from './types.js';

const CANCELLABLE_STATUSES: ReadonlySet<DurableRunStatus> = new Set([
  'running',
  'resumable',
  'suspended_interrupted',
  'waiting_park',
  'completing',
]);

const TERMINAL_OR_BLOCKED_PARENT: ReadonlySet<DurableRunStatus> = new Set([
  'failed',
  'aborted',
  'rolled_back',
  'completed',
  'needs_reconcile',
]);

const ORPHAN_CANDIDATE_STATUSES: readonly DurableRunStatus[] = [
  'running',
  'resumable',
  'suspended_interrupted',
  'waiting_park',
  'completing',
];

export interface CancelDurableOwnershipTreeInput {
  journal: DurableJournalPort;
  rootRunId: string;
  reason?: string;
  onCancelRun?: (run: DurableRunRecord) => void;
}

export interface CancelOwnershipTreeResult {
  cancelledRunIds: string[];
  childSessionIds: string[];
  visitedCompleting: string[];
}

function expireParkedSteps(journal: DurableJournalPort, runId: string, reason: string): void {
  for (const step of journal.listSteps(runId)) {
    if (step.phase !== 'parked') continue;
    journal.expireSignals(runId, step.stepId);
    journal.failStep(step.stepId, reason);
  }
}

function markDispatchedUnknown(journal: DurableJournalPort, runId: string, reason: string): void {
  for (const step of journal.listSteps(runId)) {
    if (step.phase === 'dispatched') {
      journal.markStepUnknown(step.stepId, reason);
    }
  }
}

function cancellableChildren(journal: DurableJournalPort, runId: string): DurableRunRecord[] {
  return journal.listChildRuns(runId).filter((c) => CANCELLABLE_STATUSES.has(c.status));
}

interface TreeWalkState {
  journal: DurableJournalPort;
  rootSessionId: string;
  reason: string;
  onCancelRun?: (run: DurableRunRecord) => void;
  visited: Set<string>;
  cancelledRunIds: string[];
  childSessionIds: string[];
  childSessionsSeen: Set<string>;
  visitedCompleting: string[];
}

function cancelNodeBottomUp(state: TreeWalkState, runId: string, isRoot: boolean): void {
  if (state.visited.has(runId)) return;
  state.visited.add(runId);

  const run = state.journal.getRun(runId);
  if (!run || !CANCELLABLE_STATUSES.has(run.status)) return;

  const activeKids = cancellableChildren(state.journal, runId);
  if (activeKids.length > 0 && run.status !== 'completing') {
    state.journal.updateRun(runId, { status: 'completing' });
    state.visitedCompleting.push(runId);
  }

  for (const child of activeKids) {
    cancelNodeBottomUp(state, child.runId, false);
  }

  const nodeReason = isRoot ? state.reason : 'parent_cancelled';
  expireParkedSteps(state.journal, runId, nodeReason);
  const aborted = state.journal.updateRun(runId, {
    status: 'aborted',
    errorText: nodeReason,
  });
  state.cancelledRunIds.push(runId);
  recordChildSession(state, aborted);
  state.onCancelRun?.(aborted);
}

function recordChildSession(state: TreeWalkState, run: DurableRunRecord): void {
  if (run.sessionId === state.rootSessionId) return;
  if (state.childSessionsSeen.has(run.sessionId)) return;
  state.childSessionsSeen.add(run.sessionId);
  state.childSessionIds.push(run.sessionId);
}

/**
 * Transition `rootRunId` (and any intermediate parent) through `completing`,
 * cancel deepest descendants first, then settle the root run as `aborted`.
 */
export function cancelDurableOwnershipTree(
  input: CancelDurableOwnershipTreeInput
): CancelOwnershipTreeResult {
  const root = input.journal.getRun(input.rootRunId);
  if (!root || !CANCELLABLE_STATUSES.has(root.status)) {
    return { cancelledRunIds: [], childSessionIds: [], visitedCompleting: [] };
  }
  const state: TreeWalkState = {
    journal: input.journal,
    rootSessionId: root.sessionId,
    reason: input.reason ?? 'cancelled',
    onCancelRun: input.onCancelRun,
    visited: new Set(),
    cancelledRunIds: [],
    childSessionIds: [],
    childSessionsSeen: new Set(),
    visitedCompleting: [],
  };
  cancelNodeBottomUp(state, root.runId, true);
  return {
    cancelledRunIds: state.cancelledRunIds,
    childSessionIds: state.childSessionIds,
    visitedCompleting: state.visitedCompleting,
  };
}

function hasUnsafeUnknownStep(journal: DurableJournalPort, runId: string): boolean {
  return journal
    .listSteps(runId)
    .some((s) => s.phase === 'unknown' && s.replayPolicy === 'unsafe');
}

function isParentDeadOrBlocked(journal: DurableJournalPort, parentRunId: string): boolean {
  const parent = journal.getRun(parentRunId);
  if (!parent) return true;
  if (TERMINAL_OR_BLOCKED_PARENT.has(parent.status)) return true;
  return hasUnsafeUnknownStep(journal, parent.runId);
}

function runSingleOrphanPass(journal: DurableJournalPort): DurableRunRecord[] {
  const candidates = journal.listRunsByStatus(ORPHAN_CANDIDATE_STATUSES);
  const abandoned: DurableRunRecord[] = [];
  for (const run of candidates) {
    if (!run.parentRunId) continue;
    if (!isParentDeadOrBlocked(journal, run.parentRunId)) continue;
    markDispatchedUnknown(journal, run.runId, 'abandoned_on_restart');
    expireParkedSteps(journal, run.runId, 'abandoned_on_restart');
    abandoned.push(
      journal.updateRun(run.runId, {
        status: 'aborted',
        errorText: 'abandoned_on_restart',
      })
    );
  }
  return abandoned;
}

/**
 * On boot after a crash/restart, abort any active/resumable/parked child runs
 * whose parent run is terminal, missing, or blocked on an unsafe unknown step.
 * Iterates to a fixed point so multi-level orphan subtrees converge cleanly.
 */
export function abandonOrphanChildRunsOnBoot(journal: DurableJournalPort): DurableRunRecord[] {
  const all: DurableRunRecord[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const batch = runSingleOrphanPass(journal);
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

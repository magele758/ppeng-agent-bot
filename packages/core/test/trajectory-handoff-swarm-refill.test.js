/**
 * Knife 3: parent ledger authority, refill contention, and coordinator resume.
 * One unit is one local handoff. Caps stay 3 per turn and 6 per session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryParentBudgetLedger,
  applyCoordinatorResumeEvent,
  applySuccessfulGrant,
  applyTransition,
  assessSingleWorkerRecovery,
  commitPlanRevision,
  consumeLocalUnit,
  coordinatorEventIdentity,
  createCallReservation,
  createInitialKernelState,
  escalateWorker,
  installGrantedQuota,
  markReservationUnknown,
  reconcileReservation,
  rejectCoordinator,
  resumeAfterRoleBudgetExhausted,
  usableLocalUnits,
  voidLeftoverLocalGrant,
} from '@ppeng/agent-loop';
import { commitVersionedPlan } from '../dist/tools/plan-tools.js';

const NOW = '2026-11-14T02:00:00.000Z';
const DEADLINE = '2026-11-14T03:00:00.000Z';
const LATE = '2026-11-14T03:00:00.000Z';

function request(overrides = {}) {
  return {
    refillId: 'refill-1',
    parentRunId: 'parent-1',
    workerId: 'worker-a',
    hangAttemptId: 'hang-1',
    requestedUnits: 1,
    waitDeadline: DEADLINE,
    now: NOW,
    timeoutTxnCommitted: false,
    stillAwaitingCoordinator: true,
    sessionHandoffs: 0,
    turnHandoffs: 0,
    sessionCap: 6,
    turnCap: 3,
    workerOriginalLocalCap: 3,
    ...overrides,
  };
}

function awaiting(counters = { sessionHandoffs: 1, turnHandoffs: 1 }) {
  return { state: 'awaiting_coordinator', plan: null, counters, enteredAt: NOW, turnNumber: 1 };
}

function event(overrides = {}) {
  return {
    refillId: 'refill-1',
    runId: 'parent-1',
    workerId: 'worker-a',
    dedupeId: 'dedupe-1',
    attemptId: 'attempt-2',
    hangAttemptId: 'hang-1',
    planId: 'plan-1',
    planVersion: 2,
    grantedQuota: 2,
    waitDeadline: DEADLINE,
    countAgainstGrantedQuota: true,
    ...overrides,
  };
}

test('B1 debit and grant are one decision and do not clamp N', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 4);
  const granted = await ledger.debitAndGrant(request({ requestedUnits: 2 }));
  assert.equal(granted.ok, true);
  assert.equal(granted.kind, 'granted');
  assert.equal(granted.grantedUnits, 2);
  assert.equal(granted.parentRemaining, 2);
  assert.equal(await ledger.parentRemaining('parent-1'), 2);
});

test('B2 deadline reached refuses before debit even if timeout is not committed', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const refused = await ledger.debitAndGrant(request({ now: LATE, timeoutTxnCommitted: false }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'deadline_reached');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
  const again = await ledger.debitAndGrant(request({ now: NOW }));
  assert.equal(again.reason, 'refill_id_terminal_failure');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
});

test('B3 committed timeout refuses inside the wall-clock deadline', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const refused = await ledger.debitAndGrant(request({ timeoutTxnCommitted: true, now: NOW }));
  assert.equal(refused.reason, 'timeout_committed');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
});

test('B4 leaving awaiting_coordinator refuses and does not debit', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const refused = await ledger.debitAndGrant(request({ stillAwaitingCoordinator: false }));
  assert.equal(refused.reason, 'not_awaiting_coordinator');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
});

test('B5 first committed cancel or timeout wins against a grant', async () => {
  const cancelFirst = new InMemoryParentBudgetLedger();
  cancelFirst.openParent('parent-1', 2);
  const hang = { parentRunId: 'parent-1', workerId: 'worker-a', hangAttemptId: 'hang-1' };
  const [cancelled, lateGrant] = await Promise.all([
    cancelFirst.commitCompetingTerminal(hang, 'cancel'),
    cancelFirst.debitAndGrant(request()),
  ]);
  assert.equal(cancelled.committed, true);
  assert.equal(lateGrant.ok, false);
  assert.equal(await cancelFirst.parentRemaining('parent-1'), 2);

  const grantFirst = new InMemoryParentBudgetLedger();
  grantFirst.openParent('parent-1', 2);
  const [granted, lateCancel] = await Promise.all([
    grantFirst.debitAndGrant(request({ refillId: 'grant-wins' })),
    grantFirst.commitCompetingTerminal(hang, 'timeout'),
  ]);
  assert.equal(granted.ok, true);
  assert.equal(lateCancel.committed, false);
  assert.equal(await grantFirst.parentRemaining('parent-1'), 1);
});

test('B6 the persisted waitDeadline is the clock, not a finished occupancy timer', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 2);
  const granted = await ledger.debitAndGrant(request({
    waitDeadline: '2026-11-14T04:00:00.000Z',
    now: '2026-11-14T03:30:00.000Z',
    turnHandoffs: 2,
  }));
  assert.equal(granted.ok, true);
  assert.equal(granted.grantedUnits, 1);
});

test('C1 the same refillId replays the grant and does not debit again', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const first = await ledger.debitAndGrant(request({ requestedUnits: 2 }));
  const replay = await ledger.debitAndGrant(request({ requestedUnits: 2, now: '2026-11-14T02:10:00.000Z' }));
  assert.equal(replay.kind, 'idempotent_replay');
  assert.equal(replay.grantedUnits, first.grantedUnits);
  assert.equal(replay.parentRemaining, first.parentRemaining);
  assert.equal(await ledger.parentRemaining('parent-1'), 1);
});

test('C2 a terminal refillId cannot later succeed; a non-positive N does not close the hang', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const bad = await ledger.debitAndGrant(request({ refillId: 'bad-n', requestedUnits: 0 }));
  assert.equal(bad.reason, 'non_positive_units');
  const frozen = await ledger.debitAndGrant(request({ refillId: 'bad-n', requestedUnits: 1 }));
  assert.equal(frozen.reason, 'refill_id_terminal_failure');
  const next = await ledger.debitAndGrant(request({ refillId: 'good-n', requestedUnits: 1 }));
  assert.equal(next.ok, true);
  assert.equal(await ledger.parentRemaining('parent-1'), 2);
});

test('C3 two workers racing for the last parent unit: exactly one grant', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 1);
  const [left, right] = await Promise.all([
    ledger.debitAndGrant(request({ refillId: 'left', workerId: 'worker-a', hangAttemptId: 'hang-a' })),
    ledger.debitAndGrant(request({ refillId: 'right', workerId: 'worker-b', hangAttemptId: 'hang-b' })),
  ]);
  const wins = [left, right].filter((decision) => decision.ok);
  assert.equal(wins.length, 1);
  assert.equal([left, right].some((decision) => decision.reason === 'parent_exhausted'), true);
  assert.equal(await ledger.parentRemaining('parent-1'), 0);
});

test('C4 different refillIds on one hang: exactly one decision', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 5);
  const [first, second] = await Promise.all([
    ledger.debitAndGrant(request({ refillId: 'one' })),
    ledger.debitAndGrant(request({ refillId: 'two' })),
  ]);
  assert.equal([first, second].filter((decision) => decision.ok).length, 1);
  assert.equal([first, second].some((decision) => decision.reason === 'hang_already_decided'), true);
  assert.equal(await ledger.parentRemaining('parent-1'), 4);
});

test('C5 and C6 hard caps refuse the 7th session and 4th turn handoff', async () => {
  const session = new InMemoryParentBudgetLedger();
  session.openParent('parent-1', 5);
  const seventh = await session.debitAndGrant(request({ sessionHandoffs: 6, requestedUnits: 1 }));
  assert.equal(seventh.reason, 'session_cap');
  const overRoom = await session.debitAndGrant(request({ refillId: 'room', hangAttemptId: 'hang-room', sessionHandoffs: 5, requestedUnits: 2 }));
  assert.equal(overRoom.reason, 'session_cap');
  assert.equal(await session.parentRemaining('parent-1'), 5);

  const turn = new InMemoryParentBudgetLedger();
  turn.openParent('parent-1', 5);
  const fourth = await turn.debitAndGrant(request({ turnHandoffs: 3, sessionHandoffs: 3 }));
  assert.equal(fourth.reason, 'turn_cap');
  const turnRoom = await turn.debitAndGrant(request({ refillId: 'turn-room', hangAttemptId: 'hang-turn', turnHandoffs: 2, requestedUnits: 2 }));
  assert.equal(turnRoom.reason, 'turn_cap');
  assert.equal(await turn.parentRemaining('parent-1'), 5);
});

test('C7 and C8 non-positive or over-cap N is refused with no silent clamp', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 2);
  for (const requestedUnits of [0, -1, 1.5, Number.NaN]) {
    const refused = await ledger.debitAndGrant(request({ refillId: `n-${String(requestedUnits)}`, requestedUnits }));
    assert.equal(refused.reason, 'non_positive_units');
  }
  const local = await ledger.debitAndGrant(request({ refillId: 'local', hangAttemptId: 'hang-local', requestedUnits: 2, workerOriginalLocalCap: 1 }));
  assert.equal(local.reason, 'exceeds_worker_original_local_cap');
  const parent = await ledger.debitAndGrant(request({ refillId: 'parent', hangAttemptId: 'hang-parent', requestedUnits: 3, workerOriginalLocalCap: 3 }));
  assert.equal(parent.reason, 'parent_exhausted');
  assert.equal(await ledger.parentRemaining('parent-1'), 2);
  await assert.rejects(() => ledger.debitAndGrant(request({ sessionCap: 7 })), /cannot be raised/);
});

test('C9 and C16 shared-scope escalation voids leftover and is not termination', () => {
  const local = installGrantedQuota(3);
  const escalated = escalateWorker({
    state: { state: 'executor_write', plan: null, counters: { sessionHandoffs: 2, turnHandoffs: 1 }, enteredAt: NOW, turnNumber: 1 },
    kind: 'shared_scope_escalated',
    now: NOW,
    local: { ...local, usedUnits: 1 },
  });
  assert.equal(escalated.ok, true);
  assert.equal(escalated.terminated, false);
  assert.equal(escalated.state.state, 'awaiting_coordinator');
  assert.equal(escalated.state.counters.sessionHandoffs, 2);
  assert.equal(usableLocalUnits(escalated.local), 0);
  assert.equal(escalated.local.voided, true);
});

test('C10 and C21 resume consumes one new local unit and does not debit the parent again', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 4);
  const decision = await ledger.debitAndGrant(request({ requestedUnits: 2 }));
  const applied = applySuccessfulGrant({
    state: awaiting({ sessionHandoffs: 2, turnHandoffs: 1 }),
    decision,
    now: NOW,
    target: 'executor_write',
    planVersion: 4,
    priorLocal: installGrantedQuota(3),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.state.state, 'executor_write');
  assert.equal(applied.local.usedUnits, 1);
  assert.equal(applied.local.grantedUnits, 2);
  assert.equal(applied.parentDebitedAgain, false);
  assert.equal(applied.countersZeroed, false);
  assert.equal(applied.state.counters.sessionHandoffs, 3);
  assert.equal(applied.state.counters.turnHandoffs, 2);
  assert.equal(usableLocalUnits(applied.retiredLocal), 0);
  const second = consumeLocalUnit(applied.local);
  assert.equal(second.ok, true);
  assert.equal(usableLocalUnits(second.local), 0);
  assert.equal(consumeLocalUnit(second.local).reason, 'local_exhausted');
  assert.equal(await ledger.parentRemaining('parent-1'), 2);
});

test('C11 no legal planVersion cannot enter executor_write; both planner returns work', () => {
  const decision = { ok: true, kind: 'granted', refillId: 'refill-1', hang: { parentRunId: 'parent-1', workerId: 'worker-a', hangAttemptId: 'hang-1' }, grantedUnits: 1, parentRemaining: 1 };
  const blocked = applySuccessfulGrant({ state: awaiting(), decision, now: NOW, target: 'executor_write', planVersion: 0 });
  assert.equal(blocked.reason, 'plan_version_required');
  const readonly = applySuccessfulGrant({ state: awaiting(), decision, now: NOW, target: 'planner_readonly' });
  const repair = applySuccessfulGrant({ state: awaiting(), decision, now: NOW, target: 'planner_repair' });
  assert.equal(readonly.ok && readonly.state.state, 'planner_readonly');
  assert.equal(readonly.ok && readonly.state.counters.sessionHandoffs, 1);
  assert.equal(repair.ok && repair.state.state, 'planner_repair');
  assert.equal(repair.ok && repair.local.usedUnits, 0);
});

test('C12 exhausted role budget does not enter executor_write or refill history', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const refused = await ledger.debitAndGrant(request({ roleBudgetRemaining: 0 }));
  assert.equal(refused.reason, 'role_budget_exhausted');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
  const decision = { ok: true, kind: 'granted', refillId: 'forged', hang: { parentRunId: 'parent-1', workerId: 'worker-a', hangAttemptId: 'hang-1' }, grantedUnits: 1, parentRemaining: 3 };
  const blocked = applySuccessfulGrant({
    state: awaiting({ sessionHandoffs: 4, turnHandoffs: 2 }),
    decision,
    now: NOW,
    target: 'executor_write',
    planVersion: 3,
    roleBudgetRemaining: 0,
  });
  assert.equal(blocked.reason, 'role_budget_exhausted');
  const failed = resumeAfterRoleBudgetExhausted({ state: awaiting({ sessionHandoffs: 4, turnHandoffs: 2 }), now: NOW, fallback: 'failed' });
  assert.equal(failed.ok && failed.state.state, 'failed');
  assert.equal(failed.ok && failed.enteredExecutor, false);
  assert.equal(failed.ok && failed.state.counters.sessionHandoffs, 4);
  const planner = resumeAfterRoleBudgetExhausted({ state: awaiting({ sessionHandoffs: 4, turnHandoffs: 2 }), now: NOW, fallback: 'planner_readonly' });
  assert.equal(planner.ok && planner.state.state, 'planner_readonly');
  assert.equal(planner.ok && planner.state.counters.turnHandoffs, 2);
});

test('C13 coordinator_rejected goes to failed or capped and is terminal', () => {
  const failed = rejectCoordinator(awaiting(), NOW);
  const capped = rejectCoordinator(awaiting(), NOW, 'capped');
  assert.equal(failed.ok && failed.state.state, 'failed');
  assert.equal(capped.ok && capped.state.state, 'capped');
  assert.equal(failed.terminated, true);
});

test('C14 stale attempt and stale planVersion are not applied', () => {
  const decision = { ok: true, kind: 'granted', refillId: 'refill-1', hang: { parentRunId: 'parent-1', workerId: 'worker-a', hangAttemptId: 'hang-1' }, grantedUnits: 1, parentRemaining: 2 };
  const staleAttempt = applyCoordinatorResumeEvent({
    state: awaiting(),
    event: event({ hangAttemptId: 'old-hang', attemptId: 'attempt-9' }),
    decision,
    now: NOW,
    target: 'executor_write',
    suspendedAttemptId: 'hang-1',
    acceptedPlanVersion: 2,
  });
  assert.equal(staleAttempt.reason, 'stale_instruction');
  const stalePlan = applyCoordinatorResumeEvent({
    state: awaiting(),
    event: event({ planVersion: 1 }),
    decision: { ...decision, grantedUnits: 2 },
    now: NOW,
    target: 'executor_write',
    suspendedAttemptId: 'hang-1',
    acceptedPlanVersion: 2,
  });
  assert.equal(stalePlan.reason, 'stale_instruction');
});

test('coordinator resume event is complete before a counted executor return', () => {
  assert.equal(coordinatorEventIdentity(event({ attemptId: 'hang-1' })).reason, 'attempt_not_new');
  assert.equal(coordinatorEventIdentity(event({ dedupeId: '' })).reason, 'incomplete_event');
  assert.equal(coordinatorEventIdentity(event({ planVersion: 2, planId: undefined })).reason, 'incomplete_event');
  const decision = { ok: true, kind: 'granted', refillId: 'refill-1', hang: { parentRunId: 'parent-1', workerId: 'worker-a', hangAttemptId: 'hang-1' }, grantedUnits: 2, parentRemaining: 1 };
  const uncounted = applyCoordinatorResumeEvent({
    state: awaiting(),
    event: event({ countAgainstGrantedQuota: false }),
    decision,
    now: NOW,
    target: 'executor_write',
    suspendedAttemptId: 'hang-1',
    acceptedPlanVersion: 2,
  });
  assert.equal(uncounted.reason, 'count_not_authorized');
  const applied = applyCoordinatorResumeEvent({
    state: awaiting({ sessionHandoffs: 1, turnHandoffs: 0 }),
    event: event(),
    decision,
    now: NOW,
    target: 'executor_write',
    suspendedAttemptId: 'hang-1',
    acceptedPlanVersion: 2,
  });
  assert.equal(applied.ok && applied.state.state, 'executor_write');
  assert.equal(applied.ok && applied.local.usedUnits, 1);
  assert.equal(applied.ok && applied.parentDebitedAgain, false);
});

test('C15 one expectedOldVersion accepts a single plan revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'k3-plan-'));
  const next = { version: 1, analysis: 'next', confirmed: true, steps: [{ id: 's1', title: 'step', status: 'pending' }] };
  const [left, right] = await Promise.all([
    commitVersionedPlan(dir, 'shared-plan', { ...next, analysis: 'left' }, { expectedOldVersion: 0, newVersion: 1 }),
    commitVersionedPlan(dir, 'shared-plan', { ...next, analysis: 'right' }, { expectedOldVersion: 0, newVersion: 1 }),
  ]);
  assert.equal([left, right].filter((item) => item.ok).length, 1);
  assert.equal([left, right].some((item) => item.conflict === true), true);
  const lost = commitPlanRevision({
    current: { version: 1, analysis: 'kept', steps: [] },
    expectedOldVersion: 0,
    newVersion: 1,
    next: { version: 1, analysis: 'lost', steps: [] },
  });
  assert.equal(lost.ok, false);
});

test('C17 restoring A does not ignore a peer that would go stale', () => {
  const alone = assessSingleWorkerRecovery({ workerId: 'A', peers: [{ workerId: 'B', staleIfRestored: false }] });
  assert.deepEqual(alone, { recover: 'single', workerIds: ['A'] });
  const affected = assessSingleWorkerRecovery({
    workerId: 'A',
    peers: [{ workerId: 'B', staleIfRestored: true }, { workerId: 'C', staleIfRestored: false }],
  });
  assert.equal(affected.recover, 'affected_set');
  assert.deepEqual(affected.workerIds, ['A', 'B']);
});

test('C18 and C20 escalation without an accepted plan is not executor entry or termination', () => {
  const base = createInitialKernelState({ now: NOW });
  const failed = applyTransition(base, 'fail', NOW);
  const escalated = applyTransition(base, 'escalate_no_plan', NOW);
  assert.equal(failed.ok && failed.next.state, 'failed');
  assert.equal(escalated.ok && escalated.next.state, 'awaiting_coordinator');
  assert.notEqual(escalated.ok && escalated.next.state, 'executor_write');
  const capped = escalateWorker({ state: { ...base, state: 'executor_write', counters: { sessionHandoffs: 1, turnHandoffs: 1 } }, kind: 'local_capped_escalated', now: NOW, local: installGrantedQuota(1) });
  assert.equal(capped.ok, true);
  assert.equal(capped.terminated, false);
  assert.equal(capped.state.state, 'awaiting_coordinator');
  assert.equal(capped.local.voided, false);
});

test('C19 crash reconcile is not a grant and does not debit the parent', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  const state = createInitialKernelState({ now: NOW });
  const reconciled = reconcileReservation(markReservationUnknown(createCallReservation('call-1', state, NOW)));
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.reason, 'unknown_outcome');
  assert.equal(await ledger.parentRemaining('parent-1'), 3);
  assert.equal(state.counters.sessionHandoffs, 0);
});

test('a refillId cannot be replayed onto a different hang', async () => {
  const ledger = new InMemoryParentBudgetLedger();
  ledger.openParent('parent-1', 3);
  assert.equal((await ledger.debitAndGrant(request())).ok, true);
  const stolen = await ledger.debitAndGrant(request({ workerId: 'worker-b', hangAttemptId: 'hang-b' }));
  assert.equal(stolen.reason, 'refill_id_terminal_failure');
  assert.equal(await ledger.parentRemaining('parent-1'), 2);
});

test('voided local grant is not usable beside a new grant', () => {
  const retired = voidLeftoverLocalGrant(installGrantedQuota(4));
  assert.equal(usableLocalUnits(retired), 0);
  assert.equal(usableLocalUnits(installGrantedQuota(4)), 4);
});

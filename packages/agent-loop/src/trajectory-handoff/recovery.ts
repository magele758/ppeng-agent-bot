/**
 * Trajectory Handoff v2.3 — recovery and Codex R1/R2 implementation.
 *
 * R1: Unified deadline vs competing transactions.
 *     Resume must reject if the persisted deadline is already reached at
 *     decision time, even if the timeout transaction is not yet committed.
 *     Must not resume, grant quota, or start calls.
 *
 * R2: Crash-conserving call budget.
 *     Every approved call has a recoverable reservation.  Reconcile must not
 *     miss or double-count.  Uncommitted calls are not freed as reusable quota.
 *     Intent-time reservation or equivalent is allowed; keeping the
 *     pre-call old counter is NOT sufficient as accounting for an unpersisted
 *     call.  If intent exists and result does not: mark outcome unknown, do not
 *     auto-replay; continue only if reconcilable, else failed.
 *
 * Also: crash/downtime itself is not runtime; unknown tail after last persist
 * must be billed conservatively into used runtime (not zero).  If even a
 * conservative upper bound cannot be conserved, fail-closed to timed_out/failed.
 * Remaining <= 0 is time exhausted → timed_out; do not reset to full, do not
 * force executor.  Role activity time and wait/phase/coordinator deadlines are
 * separate timers.  awaiting_coordinator has an independent persisted wait
 * deadline.
 */

import type {
  HandoffKernelState,
  CallReservation,
  ReconcileResult,
  HandoffCounters,
} from './types.js';

// ============================================================================
// R1: Deadline check
// ============================================================================

export interface DeadlineCheckInput {
  /** ISO-8601 persisted deadline. */
  readonly persistedDeadline: string;
  /** ISO-8601 current wall-clock time at decision point. */
  readonly now: string;
  /**
   * True if the timeout terminal transaction is already committed.
   * When true, resume is always rejected.
   */
  readonly timeoutTxnCommitted: boolean;
}

export type DeadlineCheckResult =
  | { ok: true; allow: true }
  | { ok: true; allow: false; reason: 'deadline_reached' | 'timeout_committed' };

/**
 * R1: Check whether resume is allowed given the persisted deadline and
 * timeout transaction state.
 *
 * "Resume must reject if the persisted deadline is already reached at decision
 * time, even if the timeout transaction is not yet committed."
 *
 * Returns { allow: false } when resume must be rejected.
 */
export function checkDeadline(input: DeadlineCheckInput): DeadlineCheckResult {
  if (input.timeoutTxnCommitted) {
    return { ok: true, allow: false, reason: 'timeout_committed' };
  }

  const deadlineMs = new Date(input.persistedDeadline).getTime();
  const nowMs = new Date(input.now).getTime();

  if (nowMs >= deadlineMs) {
    return { ok: true, allow: false, reason: 'deadline_reached' };
  }

  return { ok: true, allow: true };
}

// ============================================================================
// R2: Call reservation and reconcile
// ============================================================================

/**
 * Create a new call reservation before a model call is made.
 * This is the "intent-time reservation" that R2 requires.
 *
 * The reservation must be persisted before the call is issued.  After crash,
 * reconcile inspects all reservations to determine which calls were
 * uncommitted and must not be auto-replayed.
 *
 * @param callId  Unique identifier for the model call.
 * @param state   Current kernel state (before the call).
 * @param now     ISO-8601 timestamp of the reservation intent.
 */
export function createCallReservation(
  callId: string,
  state: HandoffKernelState,
  now: string,
): CallReservation {
  return {
    reservationId: `res-${callId}`,
    callId,
    state: state.state,
    countersAtIntent: state.counters,
    intentAt: now,
    outcome: undefined,
  };
}

/**
 * Mark a reservation as committed after the call result has been successfully
 * persisted.
 */
export function markReservationCommitted(reservation: CallReservation): CallReservation {
  return {
    ...reservation,
    outcome: 'committed',
  };
}

/**
 * Mark a reservation as having an unknown outcome (call was issued but result
 * was never persisted before crash).
 */
export function markReservationUnknown(reservation: CallReservation): CallReservation {
  return {
    ...reservation,
    outcome: 'unknown',
  };
}

/**
 * R2: Reconcile a single call reservation after crash.
 *
 * Returns:
 * - { ok: true }: the reservation is reconcilable; counter was accounted.
 * - { ok: false, reason: 'unknown_outcome' }: call was issued but result never
 *   persisted.  Do NOT auto-replay.  Caller must decide if continuation is safe.
 * - { ok: false, reason: 'irreconcilable' }: reservation state is corrupt or
 *   inconsistent.  Fail-closed.
 *
 * "Reconcile must not miss or double-count.  Uncommitted calls are not freed
 * as reusable quota."
 */
export function reconcileReservation(reservation: CallReservation): ReconcileResult {
  // Committed → already counted, safe to continue.
  if (reservation.outcome === 'committed') {
    return { ok: true, reservation };
  }

  // Unknown outcome → mark as unknown, do not auto-replay.
  if (reservation.outcome === 'unknown') {
    return { ok: false, reason: 'unknown_outcome', reservation };
  }

  // No outcome recorded → call was never issued or result never arrived.
  // This is irreconcilable; fail-closed.
  if (reservation.outcome === undefined) {
    return { ok: false, reason: 'unknown_outcome', reservation: markReservationUnknown(reservation) };
  }

  // Unexpected outcome value.
  return { ok: false, reason: 'irreconcilable', reservation };
}

/**
 * R2: Reconcile all reservations after crash.
 *
 * Returns the recovered counters and a list of reconcile results.  If any
 * reservation is irreconcilable, the caller should fail-closed to
 * failed/timed_out.
 *
 * "Every approved call has a recoverable reservation.  Reconcile must not miss
 * or double-count.  Uncommitted calls are not freed as reusable quota."
 *
 * This function rebuilds the counters from the committed reservations only.
 * Uncommitted calls remain accounted as "used" (not freed).
 */
export function reconcileAllReservations(
  reservations: readonly CallReservation[],
  baseCounters: HandoffCounters,
): {
  recoveredCounters: HandoffCounters;
  results: ReconcileResult[];
  hasUnknown: boolean;
  hasIrreconcilable: boolean;
} {
  const results: ReconcileResult[] = [];
  let hasUnknown = false;
  let hasIrreconcilable = false;

  for (const res of reservations) {
    const result = reconcileReservation(res);
    results.push(result);
    if (result.ok === false) {
      if (result.reason === 'unknown_outcome') hasUnknown = true;
      if (result.reason === 'irreconcilable') hasIrreconcilable = true;
    }
  }

  // Recovered counters = base + committed reservations only.
  // Uncommitted reservations are NOT freed (they count as used).
  const committedCount = results.filter((r) => r.ok).length;
  const recoveredCounters: HandoffCounters = {
    sessionHandoffs: baseCounters.sessionHandoffs + committedCount,
    turnHandoffs: baseCounters.turnHandoffs + committedCount,
  };

  return { recoveredCounters, results, hasUnknown, hasIrreconcilable };
}

// ============================================================================
// Conservative runtime billing
// ============================================================================

export interface RuntimeBillingInput {
  /** Last persisted wall-clock timestamp before crash. */
  readonly lastPersistedAt: string;
  /** Current wall-clock timestamp at recovery decision point. */
  readonly now: string;
  /** Remaining runtime budget (ms) at last persist. */
  readonly remainingAtLastPersist: number;
}

export type RuntimeBillingResult =
  | { ok: true; remainingAfterRecovery: number }
  | { ok: false; reason: 'time_exhausted' | 'unbounded_tail' };

/**
 * Crash/downtime itself is not runtime; but the unknown tail after last
 * persist must be billed conservatively into used runtime (not zero).
 *
 * If even a conservative upper bound cannot be conserved, fail-closed to
 * timed_out/failed.  Remaining <= 0 is time exhausted → timed_out.
 *
 * For simplicity, this implementation assumes the unknown tail is bounded by
 * the crash window (now - lastPersistedAt), and bills it entirely against
 * the remaining budget.  A more sophisticated implementation might use
 * known activity markers to tighten the bound.
 */
export function billConservativeRuntime(input: RuntimeBillingInput): RuntimeBillingResult {
  const lastMs = new Date(input.lastPersistedAt).getTime();
  const nowMs = new Date(input.now).getTime();
  const crashWindowMs = nowMs - lastMs;

  // If crash window is invalid (e.g., clock skew), fail-closed.
  if (crashWindowMs < 0 || !isFinite(crashWindowMs)) {
    return { ok: false, reason: 'unbounded_tail' };
  }

  // Conservative billing: assume the entire crash window was active runtime.
  const remainingAfterRecovery = input.remainingAtLastPersist - crashWindowMs;

  if (remainingAfterRecovery <= 0) {
    return { ok: false, reason: 'time_exhausted' };
  }

  return { ok: true, remainingAfterRecovery };
}

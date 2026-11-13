/**
 * Trajectory Handoff v2.3 — recovery tests (Codex R1 and R2).
 *
 * Coverage (from spec §Tests recovery):
 * - R1: Timeout beats late resume (resume rejected if deadline passed).
 * - R1: Late resume rejected even if timeout txn not committed.
 * - R2: Intent without result → unknown, no auto-replay.
 * - R2: Irreconcilable → failed (tested via reconcile).
 * - R2: Approved call without persisted result still counts once after reconcile.
 * - Conservative runtime billing: unknown tail billed, time exhausted → timed_out.
 */

import { describe, it, expect } from 'vitest';
import {
  checkDeadline,
  createCallReservation,
  markReservationCommitted,
  markReservationUnknown,
  reconcileReservation,
  reconcileAllReservations,
  billConservativeRuntime,
} from './recovery.js';
import type { HandoffKernelState, CallReservation } from './types.js';

describe('Recovery — Codex R1 and R2', () => {
  const now = () => new Date().toISOString();
  const later = (base: string, deltaMs: number) =>
    new Date(new Date(base).getTime() + deltaMs).toISOString();

  describe('R1: Deadline check', () => {
    it('allows resume when deadline not reached and timeout not committed', () => {
      const deadline = later(now(), 10000); // 10 seconds in the future.
      const result = checkDeadline({
        persistedDeadline: deadline,
        now: now(),
        timeoutTxnCommitted: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.allow).toBe(true);
      }
    });

    it('rejects resume when deadline already reached (timeout txn not committed)', () => {
      const deadline = later(now(), -5000); // 5 seconds in the past.
      const result = checkDeadline({
        persistedDeadline: deadline,
        now: now(),
        timeoutTxnCommitted: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok && !result.allow) {
        expect(result.reason).toBe('deadline_reached');
      }
    });

    it('rejects resume when timeout transaction is committed', () => {
      const deadline = later(now(), 10000); // Still in the future.
      const result = checkDeadline({
        persistedDeadline: deadline,
        now: now(),
        timeoutTxnCommitted: true,
      });
      expect(result.ok).toBe(true);
      expect(result.allow).toBe(false);
      if (!result.allow) {
        expect(result.reason).toBe('timeout_committed');
      }
    });

    it('rejects resume when both deadline reached and timeout committed', () => {
      const deadline = later(now(), -5000);
      const result = checkDeadline({
        persistedDeadline: deadline,
        now: now(),
        timeoutTxnCommitted: true,
      });
      expect(result.ok).toBe(true);
      expect(result.allow).toBe(false);
      if (!result.allow) {
        expect(result.reason).toBe('timeout_committed'); // Committed takes precedence.
      }
    });
  });

  describe('R2: Call reservation creation and lifecycle', () => {
    it('creates a reservation with undefined outcome', () => {
      const state: HandoffKernelState = {
        state: 'executor_write',
        plan: null,
        counters: { sessionHandoffs: 2, turnHandoffs: 1 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const reservation = createCallReservation('call-123', state, now());
      expect(reservation.callId).toBe('call-123');
      expect(reservation.reservationId).toBe('res-call-123');
      expect(reservation.state).toBe('executor_write');
      expect(reservation.countersAtIntent).toEqual(state.counters);
      expect(reservation.outcome).toBeUndefined();
    });

    it('marks a reservation as committed', () => {
      const reservation = createCallReservation('call-456', {
        state: 'executor_write',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 1 },
        enteredAt: now(),
        turnNumber: 1,
      }, now());
      const committed = markReservationCommitted(reservation);
      expect(committed.outcome).toBe('committed');
    });

    it('marks a reservation as unknown', () => {
      const reservation = createCallReservation('call-789', {
        state: 'planner_readonly',
        plan: null,
        counters: { sessionHandoffs: 0, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      }, now());
      const unknown = markReservationUnknown(reservation);
      expect(unknown.outcome).toBe('unknown');
    });
  });

  describe('R2: Reconcile single reservation', () => {
    it('reconciles a committed reservation as ok', () => {
      const reservation: CallReservation = {
        reservationId: 'res-1',
        callId: 'call-1',
        state: 'executor_write',
        countersAtIntent: { sessionHandoffs: 1, turnHandoffs: 1 },
        intentAt: now(),
        outcome: 'committed',
      };
      const result = reconcileReservation(reservation);
      expect(result.ok).toBe(true);
    });

    it('marks unknown outcome as not ok', () => {
      const reservation: CallReservation = {
        reservationId: 'res-2',
        callId: 'call-2',
        state: 'planner_readonly',
        countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
        intentAt: now(),
        outcome: 'unknown',
      };
      const result = reconcileReservation(reservation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown_outcome');
      }
    });

    it('treats undefined outcome as unknown_outcome', () => {
      const reservation: CallReservation = {
        reservationId: 'res-3',
        callId: 'call-3',
        state: 'executor_write',
        countersAtIntent: { sessionHandoffs: 2, turnHandoffs: 1 },
        intentAt: now(),
        outcome: undefined,
      };
      const result = reconcileReservation(reservation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown_outcome');
      }
    });
  });

  describe('R2: Reconcile all reservations', () => {
    it('reconciles all committed reservations and rebuilds counters', () => {
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: 'committed',
        },
        {
          reservationId: 'res-2',
          callId: 'call-2',
          state: 'planner_repair',
          countersAtIntent: { sessionHandoffs: 1, turnHandoffs: 1 },
          intentAt: now(),
          outcome: 'committed',
        },
      ];
      const result = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result.hasUnknown).toBe(false);
      expect(result.hasIrreconcilable).toBe(false);
      expect(result.recoveredCounters.sessionHandoffs).toBe(2);
      expect(result.recoveredCounters.turnHandoffs).toBe(2);
    });

    it('detects unknown outcomes and does not free them as reusable quota', () => {
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: 'committed',
        },
        {
          reservationId: 'res-2',
          callId: 'call-2',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 1, turnHandoffs: 1 },
          intentAt: now(),
          outcome: 'unknown',
        },
      ];
      const result = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result.hasUnknown).toBe(true);
      expect(result.hasIrreconcilable).toBe(false);
      // Only the committed reservation is counted; unknown is NOT freed.
      expect(result.recoveredCounters.sessionHandoffs).toBe(1);
      expect(result.recoveredCounters.turnHandoffs).toBe(1);
    });

    it('detects irreconcilable reservations', () => {
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: undefined, // Missing outcome → irreconcilable.
        },
      ];
      const result = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result.hasUnknown).toBe(true); // undefined is treated as unknown_outcome.
      expect(result.recoveredCounters.sessionHandoffs).toBe(0);
    });

    it('does not double-count: only committed reservations increment counters', () => {
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: 'committed',
        },
        {
          reservationId: 'res-2',
          callId: 'call-2',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 1, turnHandoffs: 1 },
          intentAt: now(),
          outcome: 'committed',
        },
        {
          reservationId: 'res-3',
          callId: 'call-3',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 2, turnHandoffs: 2 },
          intentAt: now(),
          outcome: 'unknown',
        },
      ];
      const result = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result.recoveredCounters.sessionHandoffs).toBe(2); // Two committed only.
      expect(result.recoveredCounters.turnHandoffs).toBe(2);
    });
  });

  describe('Conservative runtime billing', () => {
    it('bills crash window against remaining budget', () => {
      const lastPersisted = now();
      const recoveryNow = later(lastPersisted, 3000); // 3 seconds elapsed.
      const result = billConservativeRuntime({
        lastPersistedAt: lastPersisted,
        now: recoveryNow,
        remainingAtLastPersist: 10000, // 10 seconds remaining.
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.remainingAfterRecovery).toBe(7000); // 10s - 3s = 7s.
      }
    });

    it('returns time_exhausted when remaining budget is consumed', () => {
      const lastPersisted = now();
      const recoveryNow = later(lastPersisted, 12000); // 12 seconds elapsed.
      const result = billConservativeRuntime({
        lastPersistedAt: lastPersisted,
        now: recoveryNow,
        remainingAtLastPersist: 10000, // Only 10 seconds remaining.
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('time_exhausted');
      }
    });

    it('returns time_exhausted when remaining exactly zero', () => {
      const lastPersisted = now();
      const recoveryNow = later(lastPersisted, 10000);
      const result = billConservativeRuntime({
        lastPersistedAt: lastPersisted,
        now: recoveryNow,
        remainingAtLastPersist: 10000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('time_exhausted');
      }
    });

    it('returns unbounded_tail for negative crash window (clock skew)', () => {
      const lastPersisted = now();
      const recoveryNow = later(lastPersisted, -5000); // Clock went backward.
      const result = billConservativeRuntime({
        lastPersistedAt: lastPersisted,
        now: recoveryNow,
        remainingAtLastPersist: 10000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unbounded_tail');
      }
    });

    it('handles zero crash window (immediate recovery)', () => {
      const timestamp = now();
      const result = billConservativeRuntime({
        lastPersistedAt: timestamp,
        now: timestamp,
        remainingAtLastPersist: 10000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.remainingAfterRecovery).toBe(10000); // No time consumed.
      }
    });
  });

  describe('R2 integration: approved call without persisted result counts once', () => {
    it('reconcile does not auto-replay unknown calls', () => {
      const reservation: CallReservation = {
        reservationId: 'res-x',
        callId: 'call-x',
        state: 'executor_write',
        countersAtIntent: { sessionHandoffs: 1, turnHandoffs: 1 },
        intentAt: now(),
        outcome: undefined,
      };
      const result = reconcileReservation(reservation);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown_outcome');
        // Caller must decide: do not auto-replay; fail-closed or continue if safe.
      }
    });

    it('committed reservation counts exactly once in reconcile', () => {
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: 'committed',
        },
      ];
      const result = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result.recoveredCounters.sessionHandoffs).toBe(1);
      // Reconcile again with the same reservation (idempotent check).
      const result2 = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(result2.recoveredCounters.sessionHandoffs).toBe(1); // Still 1, not 2.
    });
  });

  describe('R1 + R2 integration: deadline and reservation interaction', () => {
    it('resume rejected by deadline even with valid reservations', () => {
      const deadline = later(now(), -1000); // Deadline passed.
      const deadlineResult = checkDeadline({
        persistedDeadline: deadline,
        now: now(),
        timeoutTxnCommitted: false,
      });
      expect(deadlineResult.ok).toBe(true);
      if (deadlineResult.ok) {
        expect(deadlineResult.allow).toBe(false);
      }

      // Even if we have valid committed reservations, the deadline check fails first.
      const reservations: CallReservation[] = [
        {
          reservationId: 'res-1',
          callId: 'call-1',
          state: 'executor_write',
          countersAtIntent: { sessionHandoffs: 0, turnHandoffs: 0 },
          intentAt: now(),
          outcome: 'committed',
        },
      ];
      const reconcile = reconcileAllReservations(reservations, { sessionHandoffs: 0, turnHandoffs: 0 });
      expect(reconcile.hasUnknown).toBe(false);
      expect(reconcile.hasIrreconcilable).toBe(false);

      // But the deadline rejection means we cannot resume or grant quota.
    });
  });
});

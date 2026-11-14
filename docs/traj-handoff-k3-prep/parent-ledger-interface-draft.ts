/**
 * Knife-3 PREP draft only.
 *
 * Parent-budget ledger interface sketch for waitDeadline-time atomic
 * parent debit + local grant. This file must not be imported by production
 * code, must not be wired into SwarmExecutor / host-integration, and must
 * not be copied into packages/agent-loop/src/trajectory-handoff/types.ts
 * until knife 2 has merged (public type-shape conflict risk).
 *
 * Storage and isolation technology are deliberately unset. Behaviour is not.
 *
 * Contracts: v2.3 §6.3 R1, §10; remaining-slices v1.1 §4; knife34-decomposition §2.3.
 *
 * Reuse existing kernels when implementing:
 *   checkDeadline({ persistedDeadline, now, timeoutTxnCommitted })
 *   checkHandoffCap(counters, sessionCap = 6, turnCap = 3)
 * Do not fork a second deadline or cap calculator.
 */

/** 1 unit = 1 local handoff (v2.3 §6.1 / §10). */
export type LedgerUnit = number;

export type HangIdentity = {
  readonly parentRunId: string;
  readonly workerId: string;
  /** Attempt / hang id that is currently in awaiting_coordinator. */
  readonly hangAttemptId: string;
};

export type RefillRequest = HangIdentity & {
  readonly refillId: string;
  readonly requestedUnits: LedgerUnit;
  /** ISO-8601 persisted wait deadline written when entering the hang. */
  readonly waitDeadline: string;
  /** ISO-8601 decision-time clock. */
  readonly now: string;
  readonly timeoutTxnCommitted: boolean;
  readonly stillAwaitingCoordinator: boolean;
  /** Session / turn counters already consumed (not cleared on resume). */
  readonly sessionHandoffs: number;
  readonly turnHandoffs: number;
  readonly sessionCap: number; // default 6
  readonly turnCap: number; // default 3
  /** Original local cap for this worker (grant cannot exceed it). */
  readonly workerOriginalLocalCap: number;
  /**
   * Optional role-budget remaining. If present and <= 0, grant must be
   * refused and a later resume must not enter executor_write.
   */
  readonly roleBudgetRemaining?: number;
};

export type GrantRefusalReason =
  | 'deadline_reached'
  | 'timeout_committed'
  | 'not_awaiting_coordinator'
  | 'non_positive_units'
  | 'session_cap'
  | 'turn_cap'
  | 'parent_exhausted'
  | 'exceeds_worker_original_local_cap'
  | 'role_budget_exhausted'
  | 'hang_already_decided'
  | 'refill_id_terminal_failure'
  | 'unknown_parent_run';

export type GrantDecision =
  | {
      readonly ok: true;
      readonly kind: 'granted';
      readonly refillId: string;
      readonly hang: HangIdentity;
      readonly grantedUnits: LedgerUnit;
      /** Parent remaining after this debit. */
      readonly parentRemaining: LedgerUnit;
    }
  | {
      readonly ok: true;
      readonly kind: 'idempotent_replay';
      readonly refillId: string;
      readonly hang: HangIdentity;
      /** Exact first successful grant; no additional debit or credit. */
      readonly grantedUnits: LedgerUnit;
      readonly parentRemaining: LedgerUnit;
    }
  | {
      readonly ok: false;
      readonly kind: 'refused';
      readonly refillId: string;
      readonly reason: GrantRefusalReason;
    };

/**
 * Recommended policy (lock this in tests when implementing, do not leave
 * silent undershoot undefined):
 * - Requests with N that is not a positive integer are refused.
 * - Requests with N larger than the tightest remaining cap / parent
 *   remaining / worker original local cap are refused (no silent clamp).
 * - A refillId that already failed for a terminal reason (deadline,
 *   hang already decided, caps) cannot later succeed under the same id;
 *   a new grant needs a new refillId.
 * - refillId is unique and not reusable across parent runs.
 */
export interface ParentBudgetLedger {
  /**
   * Atomic: deadline + awaiting check + parent debit + local grant.
   * Two workers racing for the last parent unit: one success, one refuse.
   * Two different refillIds racing for one hang: one decision, one refuse.
   * Same refillId retried after success: idempotent_replay.
   */
  debitAndGrant(request: RefillRequest): Promise<GrantDecision>;

  parentRemaining(parentRunId: string): Promise<LedgerUnit | null>;

  /** The successful (or empty) decision already committed for this hang. */
  decisionForHang(hang: HangIdentity): Promise<GrantDecision | null>;
}

/**
 * Host-side grant application after a successful debitAndGrant.
 * Not a second ledger. Must not debit the parent again.
 *
 * On granted / idempotent_replay:
 *   - new local attemptId
 *   - new local remaining quota starts used=0, cap=grantedUnits
 *   - session / turn / role-history counters are NOT zeroed
 *   - if a legal accepted planVersion is attached, awaiting_coordinator
 *     → executor_write counts 1 against the NEW local grant
 *   - if no legal planVersion, go planner_readonly or planner_repair
 *   - shared_scope_escalated leftover local units are already void and
 *     must not be added to the new grant
 */
export interface LocalGrantApplication {
  applySuccessfulGrant(input: {
    readonly decision: Extract<GrantDecision, { ok: true }>;
    readonly planVersion: number | null;
    readonly resumeTarget: 'executor_write' | 'planner_readonly' | 'planner_repair';
  }): void;
}

export const HARD_SESSION_CAP_DEFAULT = 6;
export const HARD_TURN_CAP_DEFAULT = 3;

/**
 * Pure pre-checks the atomic transaction must run at decision time.
 * Implementation should call checkDeadline + checkHandoffCap rather than
 * re-coding the comparisons. Kept here so skeletons can unit-test the
 * intended order without a store.
 */
export function describeDecisionOrder(): readonly string[] {
  return [
    'reject if timeoutTxnCommitted',
    'reject if now >= persisted waitDeadline, even when the timeout txn is not committed',
    'reject if not still awaiting_coordinator for this hang identity',
    'idempotent return if this refillId already succeeded',
    'reject if this refillId already has a terminal failure',
    'reject if this hang already has a different refillId decision',
    'reject if requestedUnits is not a positive integer',
    'reject if sessionHandoffs >= sessionCap (no 7th session handoff)',
    'reject if turnHandoffs >= turnCap (no 4th turn handoff)',
    'reject if requestedUnits exceeds remaining session or turn hard cap',
    'reject if requestedUnits exceeds workerOriginalLocalCap',
    'reject if requestedUnits exceeds parent remaining',
    'reject if roleBudgetRemaining is present and <= 0',
    'atomically debit parent and credit local grant',
    'void any leftover local units from shared_scope_escalated before the new grant is usable',
  ] as const;
}

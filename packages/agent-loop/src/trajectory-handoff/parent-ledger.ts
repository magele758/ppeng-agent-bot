/**
 * Parent handoff budget. One unit is one future local handoff.
 * Caps stay at the kernel constants. This ledger does not clamp N.
 * It is not the handoff state machine and it does not recover crashes.
 */
import { checkDeadline } from './recovery.js';
import { checkHandoffCap } from './state-machine.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';

export const GRANT_DECISION_ORDER = [
  'reject when timeoutTxnCommitted',
  'reject when now >= waitDeadline even if the timeout transaction is not committed',
  'reject when the worker is not awaiting_coordinator',
  'idempotent return if this refillId already succeeded',
  'reject if this refillId already has a terminal failure',
  'reject if this hang already has a different refillId decision',
  'reject non-positive N',
  'reject when sessionHandoffs is already at the hard cap',
  'reject when turnHandoffs is already at the hard cap',
  'reject when N exceeds remaining session or turn room under the cap',
  'reject when N exceeds workerOriginalLocalCap',
  'reject when N exceeds parent remaining',
  'reject when roleBudgetRemaining is present and <= 0',
  'debit parent and grant local in one decision',
  'shared-scope escalation voids leftover local quota before a new grant is usable',
] as const;

export function describeDecisionOrder(): readonly string[] {
  return GRANT_DECISION_ORDER;
}

export interface HangIdentity {
  readonly parentRunId: string;
  readonly workerId: string;
  readonly hangAttemptId: string;
}

export interface RefillRequest extends HangIdentity {
  readonly refillId: string;
  readonly requestedUnits: number;
  readonly waitDeadline: string;
  readonly now: string;
  readonly timeoutTxnCommitted: boolean;
  readonly stillAwaitingCoordinator: boolean;
  readonly sessionHandoffs: number;
  readonly turnHandoffs: number;
  readonly sessionCap: number;
  readonly turnCap: number;
  readonly workerOriginalLocalCap: number;
  readonly roleBudgetRemaining?: number;
}

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
      readonly kind: 'granted' | 'idempotent_replay';
      readonly refillId: string;
      readonly hang: HangIdentity;
      readonly grantedUnits: number;
      readonly parentRemaining: number;
    }
  | {
      readonly ok: false;
      readonly kind: 'refused';
      readonly refillId: string;
      readonly reason: GrantRefusalReason;
    };

const REFILL_TERMINAL: Partial<Record<GrantRefusalReason, true>> = {
  deadline_reached: true,
  timeout_committed: true,
  hang_already_decided: true,
  session_cap: true,
  turn_cap: true,
  parent_exhausted: true,
  exceeds_worker_original_local_cap: true,
  non_positive_units: true,
  role_budget_exhausted: true,
};

/** Adjudications that close the hang. A malformed N does not. */
const HANG_DECIDING: Partial<Record<GrantRefusalReason, true>> = {
  deadline_reached: true,
  timeout_committed: true,
  session_cap: true,
  turn_cap: true,
  parent_exhausted: true,
  exceeds_worker_original_local_cap: true,
  role_budget_exhausted: true,
};

interface Stored {
  readonly decision: GrantDecision;
  readonly decidesHang: boolean;
}

function hangKey(hang: HangIdentity): string {
  return `${hang.parentRunId}\0${hang.workerId}\0${hang.hangAttemptId}`;
}

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.length > 0;
}

export class InMemoryParentBudgetLedger {
  private readonly parents = new Map<string, number>();
  private readonly byRefill = new Map<string, Stored>();
  private readonly byHang = new Map<string, GrantDecision>();
  private chain: Promise<void> = Promise.resolve();

  openParent(parentRunId: string, initialUnits: number): void {
    if (!nonEmpty(parentRunId)) throw new Error('illegal parent run');
    if (!Number.isInteger(initialUnits) || initialUnits < 0) throw new Error('illegal parent budget');
    if (this.parents.has(parentRunId)) throw new Error('parent already open');
    this.parents.set(parentRunId, initialUnits);
  }

  parentRemaining(parentRunId: string): Promise<number | null> {
    return this.enqueue(() => (this.parents.has(parentRunId) ? this.parents.get(parentRunId)! : null));
  }

  debitAndGrant(request: RefillRequest): Promise<GrantDecision> {
    return this.enqueue(() => this.decide(request));
  }

  /**
   * First committed cancel or timeout wins. A later grant cannot reopen the hang.
   * A grant that already won is not rolled back.
   */
  commitCompetingTerminal(
    hang: HangIdentity,
    kind: 'cancel' | 'timeout',
  ): Promise<{ readonly committed: boolean; readonly reason: GrantRefusalReason }> {
    return this.enqueue(() => {
      if (!nonEmpty(hang.parentRunId) || !nonEmpty(hang.workerId) || !nonEmpty(hang.hangAttemptId)) {
        throw new Error('illegal refill identity');
      }
      const key = hangKey(hang);
      const prior = this.byHang.get(key);
      if (prior) {
        return { committed: false, reason: prior.ok ? 'hang_already_decided' : prior.reason };
      }
      const reason: GrantRefusalReason = kind === 'timeout' ? 'timeout_committed' : 'not_awaiting_coordinator';
      const decision: GrantDecision = { ok: false, kind: 'refused', refillId: `terminal:${kind}`, reason };
      this.byHang.set(key, decision);
      return { committed: true, reason };
    });
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private decide(request: RefillRequest): GrantDecision {
    if (
      !nonEmpty(request.refillId) ||
      !nonEmpty(request.parentRunId) ||
      !nonEmpty(request.workerId) ||
      !nonEmpty(request.hangAttemptId)
    ) {
      throw new Error('illegal refill identity');
    }
    if (
      !Number.isInteger(request.sessionCap) ||
      !Number.isInteger(request.turnCap) ||
      request.sessionCap < 1 ||
      request.turnCap < 1 ||
      request.sessionCap > DEFAULT_SESSION_CAP ||
      request.turnCap > DEFAULT_TURN_CAP
    ) {
      throw new Error('handoff caps cannot be raised or non-positive');
    }
    if (
      !Number.isInteger(request.sessionHandoffs) ||
      !Number.isInteger(request.turnHandoffs) ||
      request.sessionHandoffs < 0 ||
      request.turnHandoffs < 0 ||
      !Number.isInteger(request.workerOriginalLocalCap) ||
      request.workerOriginalLocalCap < 0
    ) {
      throw new Error('illegal handoff counters');
    }

    const refuse = (reason: GrantRefusalReason): GrantDecision => {
      const decision: GrantDecision = { ok: false, kind: 'refused', refillId: request.refillId, reason };
      if (REFILL_TERMINAL[reason] === true && !this.byRefill.has(request.refillId)) {
        this.byRefill.set(request.refillId, { decision, decidesHang: HANG_DECIDING[reason] === true });
      }
      if (HANG_DECIDING[reason] === true && !this.byHang.has(hangKey(request))) {
        this.byHang.set(hangKey(request), decision);
      }
      return decision;
    };

    const deadlineMs = Date.parse(request.waitDeadline);
    const nowMs = Date.parse(request.now);
    if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return refuse('deadline_reached');
    const deadline = checkDeadline({
      persistedDeadline: request.waitDeadline,
      now: request.now,
      timeoutTxnCommitted: request.timeoutTxnCommitted === true,
    });
    if (!deadline.allow) return refuse(deadline.reason);

    if (request.stillAwaitingCoordinator !== true) return refuse('not_awaiting_coordinator');

    const prior = this.byRefill.get(request.refillId);
    if (prior?.decision.ok) {
      const same =
        prior.decision.hang.parentRunId === request.parentRunId &&
        prior.decision.hang.workerId === request.workerId &&
        prior.decision.hang.hangAttemptId === request.hangAttemptId;
      if (!same) {
        return { ok: false, kind: 'refused', refillId: request.refillId, reason: 'refill_id_terminal_failure' };
      }
      return {
        ok: true,
        kind: 'idempotent_replay',
        refillId: request.refillId,
        hang: prior.decision.hang,
        grantedUnits: prior.decision.grantedUnits,
        parentRemaining: prior.decision.parentRemaining,
      };
    }
    if (prior && !prior.decision.ok) {
      return { ok: false, kind: 'refused', refillId: request.refillId, reason: 'refill_id_terminal_failure' };
    }

    const hangDecision = this.byHang.get(hangKey(request));
    if (hangDecision) return refuse('hang_already_decided');

    if (!Number.isInteger(request.requestedUnits) || request.requestedUnits <= 0) return refuse('non_positive_units');

    const cap = checkHandoffCap(
      { sessionHandoffs: request.sessionHandoffs, turnHandoffs: request.turnHandoffs },
      request.sessionCap,
      request.turnCap,
    );
    if (!cap.allowed) return refuse(cap.reason ?? 'session_cap');

    if (request.requestedUnits > request.sessionCap - request.sessionHandoffs) return refuse('session_cap');
    if (request.requestedUnits > request.turnCap - request.turnHandoffs) return refuse('turn_cap');
    if (request.requestedUnits > request.workerOriginalLocalCap) return refuse('exceeds_worker_original_local_cap');

    const parent = this.parents.get(request.parentRunId);
    if (parent === undefined) return refuse('unknown_parent_run');
    if (request.requestedUnits > parent) return refuse('parent_exhausted');

    if (request.roleBudgetRemaining !== undefined && !(request.roleBudgetRemaining > 0)) {
      return refuse('role_budget_exhausted');
    }

    const parentRemaining = parent - request.requestedUnits;
    this.parents.set(request.parentRunId, parentRemaining);
    const granted: GrantDecision = {
      ok: true,
      kind: 'granted',
      refillId: request.refillId,
      hang: {
        parentRunId: request.parentRunId,
        workerId: request.workerId,
        hangAttemptId: request.hangAttemptId,
      },
      grantedUnits: request.requestedUnits,
      parentRemaining,
    };
    this.byRefill.set(request.refillId, { decision: granted, decidesHang: true });
    this.byHang.set(hangKey(request), granted);
    return granted;
  }
}

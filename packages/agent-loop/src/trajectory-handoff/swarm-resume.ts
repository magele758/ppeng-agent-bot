/**
 * Local quota and coordinator resume. Parent units are already decided
 * by InMemoryParentBudgetLedger. Applying a grant does not debit again
 * and does not zero session, turn, or role history.
 */
import type { GrantDecision } from './parent-ledger.js';
import { applyTransition, isSuspended, isTerminal } from './state-machine.js';
import type { CoordinatorResumeEvent, HandoffKernelState } from './types.js';

export interface LocalGrant {
  readonly grantedUnits: number;
  readonly usedUnits: number;
  readonly voided: boolean;
}

export type ResumeTarget = 'executor_write' | 'planner_readonly' | 'planner_repair';

export function legalPlanVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function usableLocalUnits(grant: LocalGrant | null | undefined): number {
  if (!grant || grant.voided) return 0;
  return Math.max(0, grant.grantedUnits - grant.usedUnits);
}

export function installGrantedQuota(grantedUnits: number): LocalGrant {
  return { grantedUnits, usedUnits: 0, voided: false };
}

export function voidLeftoverLocalGrant(grant: LocalGrant | null | undefined): LocalGrant {
  if (!grant) return { grantedUnits: 0, usedUnits: 0, voided: true };
  return { grantedUnits: grant.grantedUnits, usedUnits: grant.grantedUnits, voided: true };
}

export function classifyCoordinatorInstruction(input: {
  readonly hangAttemptId: string;
  readonly eventAttemptId: string;
  readonly acceptedPlanVersion: number | null;
  readonly eventPlanVersion?: number | null;
}): 'apply' | 'ignore_old_attempt' | 'discard_stale_plan' {
  if (input.eventAttemptId !== input.hangAttemptId) return 'ignore_old_attempt';
  if (
    legalPlanVersion(input.acceptedPlanVersion) &&
    legalPlanVersion(input.eventPlanVersion) &&
    input.eventPlanVersion < input.acceptedPlanVersion
  ) {
    return 'discard_stale_plan';
  }
  return 'apply';
}

export function assessSingleWorkerRecovery(input: {
  readonly workerId: string;
  readonly peers: readonly { readonly workerId: string; readonly staleIfRestored: boolean }[];
}): { readonly recover: 'single'; readonly workerIds: readonly string[] } | {
  readonly recover: 'affected_set';
  readonly workerIds: readonly string[];
} {
  const stale = input.peers.filter((peer) => peer.staleIfRestored).map((peer) => peer.workerId);
  if (stale.length === 0) return { recover: 'single', workerIds: [input.workerId] };
  return {
    recover: 'affected_set',
    workerIds: [input.workerId, ...stale.filter((id) => id !== input.workerId)],
  };
}

export function escalateWorker(input: {
  readonly state: HandoffKernelState;
  readonly kind: 'shared_scope_escalated' | 'local_capped_escalated';
  readonly now: string;
  readonly local: LocalGrant | null;
}): { readonly ok: true; readonly state: HandoffKernelState; readonly local: LocalGrant; readonly terminated: false } | {
  readonly ok: false;
  readonly reason: string;
} {
  const result = applyTransition(input.state, input.kind, input.now);
  if (!result.ok) return { ok: false, reason: result.error };
  const local = input.kind === 'shared_scope_escalated'
    ? voidLeftoverLocalGrant(input.local)
    : (input.local ?? { grantedUnits: 0, usedUnits: 0, voided: false });
  return { ok: true, state: result.next, local, terminated: false };
}

export function rejectCoordinator(
  state: HandoffKernelState,
  now: string,
  outcome: 'failed' | 'capped' = 'failed',
): { readonly ok: true; readonly state: HandoffKernelState; readonly terminated: true } | {
  readonly ok: false;
  readonly reason: string;
} {
  const result = applyTransition(state, 'coordinator_rejected', now, undefined, { rejection: outcome });
  if (!result.ok) return { ok: false, reason: result.error };
  return { ok: true, state: result.next, terminated: true };
}

export function coordinatorSuspension(state: HandoffKernelState): {
  readonly suspended: boolean;
  readonly terminated: boolean;
} {
  return { suspended: isSuspended(state.state), terminated: isTerminal(state.state) };
}

export type ApplyGrantResult =
  | {
      readonly ok: true;
      readonly state: HandoffKernelState;
      readonly local: LocalGrant;
      readonly retiredLocal: LocalGrant | null;
      readonly parentDebitedAgain: false;
      readonly countersZeroed: false;
    }
  | {
      readonly ok: false;
      readonly reason: 'grant_not_success' | 'stale_instruction' | 'not_awaiting_coordinator' | 'plan_version_required' | 'role_budget_exhausted' | string;
    };

export function applySuccessfulGrant(input: {
  readonly state: HandoffKernelState;
  readonly decision: GrantDecision;
  readonly now: string;
  readonly target: ResumeTarget;
  readonly planVersion?: number | null;
  readonly roleBudgetRemaining?: number;
  readonly priorLocal?: LocalGrant | null;
  readonly instruction?: {
    readonly hangAttemptId: string;
    readonly eventAttemptId: string;
    readonly acceptedPlanVersion: number | null;
    readonly eventPlanVersion?: number | null;
  };
}): ApplyGrantResult {
  if (!input.decision.ok) return { ok: false, reason: 'grant_not_success' };
  if (input.instruction) {
    const kind = classifyCoordinatorInstruction(input.instruction);
    if (kind !== 'apply') return { ok: false, reason: 'stale_instruction' };
  }
  if (input.state.state !== 'awaiting_coordinator') return { ok: false, reason: 'not_awaiting_coordinator' };
  if (input.target === 'executor_write') {
    if (!legalPlanVersion(input.planVersion)) return { ok: false, reason: 'plan_version_required' };
    if (input.roleBudgetRemaining !== undefined && !(input.roleBudgetRemaining > 0)) {
      return { ok: false, reason: 'role_budget_exhausted' };
    }
  }
  const event = input.target === 'executor_write'
    ? 'coordinator_resumed'
    : input.target === 'planner_repair'
      ? 'coordinator_repair'
      : 'coordinator_no_plan';
  const result = applyTransition(input.state, event, input.now);
  if (!result.ok) return { ok: false, reason: result.error };
  return {
    ok: true,
    state: result.next,
    local: {
      grantedUnits: input.decision.grantedUnits,
      usedUnits: result.counted ? 1 : 0,
      voided: false,
    },
    retiredLocal: input.priorLocal ? voidLeftoverLocalGrant(input.priorLocal) : null,
    parentDebitedAgain: false,
    countersZeroed: false,
  };
}

export function consumeLocalUnit(
  grant: LocalGrant,
): { readonly ok: true; readonly local: LocalGrant } | { readonly ok: false; readonly reason: 'local_exhausted' } {
  if (grant.voided || grant.usedUnits >= grant.grantedUnits) return { ok: false, reason: 'local_exhausted' };
  return { ok: true, local: { grantedUnits: grant.grantedUnits, usedUnits: grant.usedUnits + 1, voided: false } };
}

export function coordinatorEventIdentity(event: CoordinatorResumeEvent):
  | {
      readonly ok: true;
      readonly parentRunId: string;
      readonly workerId: string;
      readonly hangAttemptId: string;
      readonly attemptId: string;
      readonly refillId: string;
      readonly dedupeId: string;
      readonly grantedQuota: number;
      readonly waitDeadline: string;
      readonly countAgainstGrantedQuota: boolean;
      readonly planId?: string;
      readonly planVersion?: number;
    }
  | { readonly ok: false; readonly reason: 'incomplete_event' | 'attempt_not_new' } {
  const required = [event.refillId, event.runId, event.workerId, event.dedupeId, event.attemptId, event.hangAttemptId, event.waitDeadline];
  if (required.some((value) => typeof value !== 'string' || value.length === 0)) {
    return { ok: false, reason: 'incomplete_event' };
  }
  if (!Number.isInteger(event.grantedQuota) || event.grantedQuota <= 0) return { ok: false, reason: 'incomplete_event' };
  if (typeof event.countAgainstGrantedQuota !== 'boolean') return { ok: false, reason: 'incomplete_event' };
  if (event.attemptId === event.hangAttemptId) return { ok: false, reason: 'attempt_not_new' };
  if (event.planVersion !== undefined && !legalPlanVersion(event.planVersion)) return { ok: false, reason: 'incomplete_event' };
  if (legalPlanVersion(event.planVersion) && (typeof event.planId !== 'string' || event.planId.length === 0)) {
    return { ok: false, reason: 'incomplete_event' };
  }
  return {
    ok: true,
    parentRunId: event.runId,
    workerId: event.workerId,
    hangAttemptId: event.hangAttemptId,
    attemptId: event.attemptId,
    refillId: event.refillId,
    dedupeId: event.dedupeId,
    grantedQuota: event.grantedQuota,
    waitDeadline: event.waitDeadline,
    countAgainstGrantedQuota: event.countAgainstGrantedQuota,
    ...(typeof event.planId === 'string' ? { planId: event.planId } : {}),
    ...(event.planVersion !== undefined ? { planVersion: event.planVersion } : {}),
  };
}

export function applyCoordinatorResumeEvent(input: {
  readonly state: HandoffKernelState;
  readonly event: CoordinatorResumeEvent;
  readonly decision: GrantDecision;
  readonly now: string;
  readonly target: ResumeTarget;
  readonly suspendedAttemptId: string;
  readonly acceptedPlanVersion: number | null;
  readonly roleBudgetRemaining?: number;
  readonly priorLocal?: LocalGrant | null;
}): ApplyGrantResult {
  const identity = coordinatorEventIdentity(input.event);
  if (!identity.ok) return { ok: false, reason: identity.reason };
  if (identity.hangAttemptId !== input.suspendedAttemptId) return { ok: false, reason: 'stale_instruction' };
  if (!input.decision.ok) return { ok: false, reason: 'grant_not_success' };
  if (input.decision.refillId !== identity.refillId || input.decision.grantedUnits !== identity.grantedQuota) {
    return { ok: false, reason: 'grant_quota_mismatch' };
  }
  if (input.target === 'executor_write' && identity.countAgainstGrantedQuota !== true) {
    return { ok: false, reason: 'count_not_authorized' };
  }
  return applySuccessfulGrant({
    state: input.state,
    decision: input.decision,
    now: input.now,
    target: input.target,
    planVersion: identity.planVersion,
    roleBudgetRemaining: input.roleBudgetRemaining,
    priorLocal: input.priorLocal,
    instruction: {
      hangAttemptId: input.suspendedAttemptId,
      eventAttemptId: identity.hangAttemptId,
      acceptedPlanVersion: input.acceptedPlanVersion,
      eventPlanVersion: identity.planVersion ?? null,
    },
  });
}

/** Role budget stays exhausted. Never enters executor_write and never refills the cumulative budget. */
export function resumeAfterRoleBudgetExhausted(input: {
  readonly state: HandoffKernelState;
  readonly now: string;
  readonly fallback: 'failed' | 'planner_readonly' | 'planner_repair';
}): { readonly ok: true; readonly state: HandoffKernelState; readonly enteredExecutor: false; readonly countersZeroed: false } | {
  readonly ok: false;
  readonly reason: string;
} {
  if (input.fallback === 'failed') {
    const rejected = rejectCoordinator(input.state, input.now, 'failed');
    if (!rejected.ok) return rejected;
    return { ok: true, state: rejected.state, enteredExecutor: false, countersZeroed: false };
  }
  const event = input.fallback === 'planner_repair' ? 'coordinator_repair' : 'coordinator_no_plan';
  const result = applyTransition(input.state, event, input.now);
  if (!result.ok) return { ok: false, reason: result.error };
  if (result.next.state === 'executor_write') return { ok: false, reason: 'role_budget_exhausted' };
  return { ok: true, state: result.next, enteredExecutor: false, countersZeroed: false };
}

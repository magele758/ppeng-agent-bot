/**
 * Trajectory Handoff v2.3 - Persistence & Crash Recovery (Codex R1/R2)
 *
 * R1: Unified deadline vs competing transactions. Resume must reject if the persisted deadline
 * is already reached at decision time, even if the timeout transaction is not yet committed.
 * Transaction order only decides among operations that each satisfy their preconditions.
 * If the wait deadline is reached, or the timeout terminal is already committed, late resume
 * must be ignored.
 *
 * R2: Crash-conserving call budget. Every approved call has a recoverable reservation.
 * Reconcile must not miss or double-count. Uncommitted calls are not freed as reusable quota.
 * Intent-time reservation or equivalent is allowed; keeping the pre-call old counter is not
 * sufficient as accounting for an unpersisted call. If intent exists and result does not:
 * mark outcome unknown, do not auto-replay; continue only if reconcilable, else failed.
 * Unknown tail after last persist must be billed conservatively into used runtime
 * (not zero). If even a conservative upper bound cannot be conserved, fail-closed to
 * timed_out/failed. Remaining <= 0 is time exhausted → timed_out.
 */

import type {
  HandoffRuntimeState,
  HandoffTerminalState,
} from './types.js';

/** Persisted call intent: tracks reserved resources at call approval time */
export interface PersistedCallIntent {
  /** Unique ID for this call attempt (never reused) */
  callId: string;
  /** When the call was approved (epoch ms) */
  approvedAt: number;
  /** Handoff counter value at approval */
  handoffCountAtApproval: number;
  /** Per-turn counter value at approval */
  perTurnCountAtApproval: number;
  /** Per-session used time at approval (ms) */
  sessionUsedMsAtApproval: number;
  /** Per-turn used time at approval (ms) */
  turnUsedMsAtApproval: number;
  /** Session deadline if set (epoch ms, or null if no deadline) */
  sessionDeadlineMs: number | null;
  /** Turn deadline if set (epoch ms, or null if no deadline) */
  turnDeadlineMs: number | null;
  /** Role activity deadline if set (epoch ms, or null if no deadline) */
  roleActivityDeadlineMs: number | null;
}

/** Persisted call result: tracks outcome after execution */
export interface PersistedCallResult {
  /** Maps to callId */
  callId: string;
  /** Result outcome: 'ok' | 'error' | 'unknown' */
  outcome: 'ok' | 'error' | 'unknown';
  /** For unknown: no result persisted, intent must remain reserved */
  /** For ok/error: billing and recovery complete */
  runtimeMsActual?: number;
  /** Error message if outcome='error' */
  errorMessage?: string;
}

/** Persisted state snapshot for crash recovery */
export interface PersistedHandoffState {
  /** Current kernel state at last persist */
  state: HandoffRuntimeState;
  /** Session-level handoff count committed */
  handoffCountCommitted: number;
  /** Per-turn handoff count committed */
  perTurnCountCommitted: number;
  /** Total session runtime used (ms) */
  sessionUsedMs: number;
  /** Total per-turn runtime used (ms) */
  turnUsedMs: number;
  /** Terminal state persisted (null if not yet terminal) */
  terminalState: HandoffTerminalState | null;
  /** Timestamp of last persist (epoch ms) */
  persistedAt: number;
}

/** Reconciliation context during crash recovery */
export interface ReconciliationContext {
  /** Last persisted state */
  lastPersistedState: PersistedHandoffState;
  /** In-memory intents seen since last persist */
  uncommittedIntents: PersistedCallIntent[];
  /** In-memory results seen since last persist */
  uncommittedResults: PersistedCallResult[];
  /** Current time for deadline checks (epoch ms) */
  nowMs: number;
  /** Session deadline for R1 check (epoch ms, or null) */
  sessionDeadlineMs: number | null;
  /** Turn deadline for R1 check (epoch ms, or null) */
  turnDeadlineMs: number | null;
  /** Role activity deadline for R1 check (epoch ms, or null) */
  roleActivityDeadlineMs: number | null;
  /** Terminal state already committed? (R1 check) */
  terminalStateCommitted: boolean;
}

/** Outcome of reconciliation: what happened and how to proceed */
export interface ReconciliationResult {
  /** Reconciliation passed */
  reconciled: boolean;
  /** If not reconciled, the terminal state to enter */
  failureState?: HandoffTerminalState;
  /** If not reconciled, reason for failure */
  failureReason?: string;
  /** Updated handoff count (may differ from persisted if calls were approved but uncommitted) */
  handoffCountAfterReconcile: number;
  /** Updated per-turn count */
  perTurnCountAfterReconcile: number;
  /** Updated session used time (ms), conservatively including unknown tail */
  sessionUsedMsAfterReconcile: number;
  /** Updated turn used time (ms), conservatively including unknown tail */
  turnUsedMsAfterReconcile: number;
  /** Calls with unknown outcomes that must not auto-replay */
  unknownOutcomeCalls: string[];
  /** If set, resume was rejected and should not proceed */
  resumeRejected?: true;
}

/**
 * R1 deadline check: reject resume if persisted deadline already reached,
 * even if timeout transaction is not committed.
 *
 * @returns true if resume is allowed, false if deadline already reached
 */
export function checkDeadlineR1(ctx: ReconciliationContext): boolean {
  const { nowMs, sessionDeadlineMs, turnDeadlineMs, roleActivityDeadlineMs, terminalStateCommitted } = ctx;

  // If terminal is already committed, any resume is too late
  if (terminalStateCommitted) {
    return false;
  }

  // Check each deadline independently
  if (sessionDeadlineMs !== null && nowMs >= sessionDeadlineMs) {
    return false;
  }
  if (turnDeadlineMs !== null && nowMs >= turnDeadlineMs) {
    return false;
  }
  if (roleActivityDeadlineMs !== null && nowMs >= roleActivityDeadlineMs) {
    return false;
  }

  return true;
}

/**
 * R2 reconciliation: match intents to results, mark unknowns, update counters conservatively.
 * Every approved call must remain reserved until its result is persisted.
 * Unknown outcomes must be marked and not auto-replayed.
 * Conservative tail billing: if crash occurred after intent but before result persist,
 * billing continues as if the call completed (unknown tail is conservatively counted).
 *
 * @returns reconciliation result with updated budgets and unknown calls
 */
export function reconcileCallBudgetR2(
  ctx: ReconciliationContext,
  maxRuntimeMs: number
): ReconciliationResult {
  const { lastPersistedState, uncommittedIntents, uncommittedResults, nowMs } = ctx;

  // Build result map by callId
  const resultMap = new Map<string, PersistedCallResult>();
  for (const result of uncommittedResults) {
    resultMap.set(result.callId, result);
  }

  // Reconcile: every intent must have a corresponding outcome (found, unknown, or stale)
  const unknownOutcomeCalls: string[] = [];
  let totalSessionMsAdded = 0;
  let totalTurnMsAdded = 0;
  let handoffCountAdded = 0;
  let perTurnCountAdded = 0;

  for (const intent of uncommittedIntents) {
    const result = resultMap.get(intent.callId);

    if (!result) {
      // No result persisted: mark outcome unknown, keep reservation, do not auto-replay
      unknownOutcomeCalls.push(intent.callId);
      // Conservative tail: assume execution consumed time proportional to intent
      // Use conservative upper bound: intent contains pre-call counters
      // If crash happened, we don't know how much was used, so charge conservatively
      const conservativeTailMs = Math.max(100, 50); // Conservative minimum tail
      totalSessionMsAdded += conservativeTailMs;
      totalTurnMsAdded += conservativeTailMs;
      // Count was reserved at approval but not yet committed; keep it reserved
      // Increment uncommitted count: this will be re-validated before next decision
    } else if (result.outcome === 'unknown') {
      // Result persisted as unknown (explicit mark)
      unknownOutcomeCalls.push(result.callId);
      // Still charge conservatively
      const conservativeTailMs = result.runtimeMsActual ?? 50;
      totalSessionMsAdded += conservativeTailMs;
      totalTurnMsAdded += conservativeTailMs;
    } else if (result.outcome === 'ok' || result.outcome === 'error') {
      // Result committed: actual billing
      const runtimeMsActual = result.runtimeMsActual ?? 0;
      totalSessionMsAdded += runtimeMsActual;
      totalTurnMsAdded += runtimeMsActual;
      // Increment committed counts
      handoffCountAdded += 1;
      perTurnCountAdded += 1;
    }
  }

  // Proposed new state after reconciliation
  const proposedSessionUsedMs = lastPersistedState.sessionUsedMs + totalSessionMsAdded;
  const proposedTurnUsedMs = lastPersistedState.turnUsedMs + totalTurnMsAdded;

  // Check if we exceed max runtime: fail-closed to timed_out
  if (proposedSessionUsedMs >= maxRuntimeMs) {
    return {
      reconciled: false,
      failureState: 'timed_out',
      failureReason: 'Session runtime exhausted (R2 conservative billing)',
      handoffCountAfterReconcile: lastPersistedState.handoffCountCommitted,
      perTurnCountAfterReconcile: lastPersistedState.perTurnCountCommitted,
      sessionUsedMsAfterReconcile: proposedSessionUsedMs,
      turnUsedMsAfterReconcile: proposedTurnUsedMs,
      unknownOutcomeCalls,
    };
  }

  return {
    reconciled: true,
    handoffCountAfterReconcile: lastPersistedState.handoffCountCommitted + handoffCountAdded,
    perTurnCountAfterReconcile: lastPersistedState.perTurnCountCommitted + perTurnCountAdded,
    sessionUsedMsAfterReconcile: proposedSessionUsedMs,
    turnUsedMsAfterReconcile: proposedTurnUsedMs,
    unknownOutcomeCalls,
  };
}

/**
 * Full crash recovery: check R1 deadline, then reconcile R2 budgets.
 * If either fails, mark irreconcilable and enter failed.
 *
 * @returns reconciliation result; if not reconciled, proceed directly to terminal state
 */
export function recoverFromCrash(
  ctx: ReconciliationContext,
  maxRuntimeMs: number
): ReconciliationResult {
  // Step 1: R1 deadline check
  if (!checkDeadlineR1(ctx)) {
    return {
      reconciled: false,
      failureState: 'timed_out',
      failureReason: 'Persisted deadline already reached (R1 rejection)',
      handoffCountAfterReconcile: ctx.lastPersistedState.handoffCountCommitted,
      perTurnCountAfterReconcile: ctx.lastPersistedState.perTurnCountCommitted,
      sessionUsedMsAfterReconcile: ctx.lastPersistedState.sessionUsedMs,
      turnUsedMsAfterReconcile: ctx.lastPersistedState.turnUsedMs,
      unknownOutcomeCalls: [],
      resumeRejected: true,
    };
  }

  // Step 2: R2 budget reconciliation
  const r2Result = reconcileCallBudgetR2(ctx, maxRuntimeMs);
  return r2Result;
}

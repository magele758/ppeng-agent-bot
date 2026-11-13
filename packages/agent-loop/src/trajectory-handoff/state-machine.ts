/**
 * Trajectory Handoff v2.3 — state machine (pure functions).
 *
 * All transitions are defined as a lookup table.  Illegal transitions throw
 * (fail-fast; indicates a programming bug).  Counting rules are co-located
 * with the transition table.
 *
 * Key counting rules (from spec §Counting):
 *  - Entering planner_readonly:         NOT a handoff.
 *  - planner_readonly → answered:       NOT a handoff.
 *  - plan_ready → executor_write:       +1.
 *  - executor_write → planner_repair:   +1.
 *  - planner_repair → executor_write:   +1 (round-trip = 2 total).
 *  - awaiting_coordinator → executor_write (coordinator_resumed): +1 against
 *    newly granted local quota; parent already deducted at grant time.
 *  - awaiting_coordinator → planner_readonly/planner_repair: does NOT count.
 *  - Same-role retry, tool retry, continuation, crash resume: do NOT count.
 *  - 6th legal handoff occupancy may finish; 7th request is capped.
 *  - Per-turn cap 3 behaves symmetrically.
 */

import type {
  HandoffState,
  HandoffActiveState,
  HandoffSuspendState,
  HandoffTerminalState,
  HandoffEvent,
  HandoffKernelState,
  HandoffCounters,
  CoordinatorResumeEvent,
} from './types.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';

// ============================================================================
// Transition table
// ============================================================================

/**
 * Each entry maps (fromState × event) → toState.
 * Missing entries are illegal transitions.
 */
const TRANSITIONS: Partial<Record<HandoffState, Partial<Record<HandoffEvent, HandoffState>>>> = {
  planner_readonly: {
    direct_answer:   'answered',
    submit_plan:     'plan_ready',
    escalate_no_plan:'awaiting_coordinator',
    escalate:        'awaiting_coordinator',
    fail:            'failed',
    cancel:          'cancelled',
    timeout:         'timed_out',
  },
  plan_ready: {
    activate_executor: 'executor_write',
    pin_failed:        'failed',
    budget_insufficient: 'awaiting_coordinator',
    cap_exceeded:      'capped',
    escalate:          'awaiting_coordinator',
    fail:              'failed',
    cancel:            'cancelled',
    timeout:           'timed_out',
  },
  executor_write: {
    local_done:        'done',
    friction:          'planner_repair',
    coordinator_resumed:'awaiting_coordinator',  // executor → awaiting when re-escalating
    escalate:          'awaiting_coordinator',
    cap_exceeded:      'capped',
    fail:              'failed',
    cancel:            'cancelled',
    timeout:           'timed_out',
  },
  planner_repair: {
    activate_executor: 'executor_write',
    escalate:          'awaiting_coordinator',
    cap_exceeded:      'capped',
    fail:              'failed',
    cancel:            'cancelled',
    timeout:           'timed_out',
  },
  awaiting_coordinator: {
    coordinator_resumed: 'executor_write',
    coordinator_no_plan: 'planner_readonly',
    coordinator_repair:  'planner_repair',
    escalate:            'awaiting_coordinator',
    cap_exceeded:        'capped',
    fail:                'failed',
    cancel:              'cancelled',
    timeout:             'timed_out',
  },
  // Terminal states: no outgoing edges.
  answered:   {},
  done:       {},
  capped:     {},
  failed:     {},
  cancelled:  {},
  timed_out:  {},
};

// ============================================================================
// Handoff-incrementing edges
// (spec §Counting — only these edges increment the counter)
// ============================================================================

/**
 * Returns +1 if this (from, event) pair increments the handoff counter,
 * or 0 otherwise.
 *
 * Note: awaiting_coordinator → executor_write via coordinator_resumed is
 * handled separately in applyTransition because it counts against the
 * *granted* quota, not the global session counter tracked here.
 */
function handoffIncrement(from: HandoffState, event: HandoffEvent): 0 | 1 {
  if (from === 'plan_ready' && event === 'activate_executor') return 1;
  if (from === 'executor_write' && event === 'friction') return 1;
  if (from === 'planner_repair' && event === 'activate_executor') return 1;
  if (from === 'awaiting_coordinator' && event === 'coordinator_resumed') return 1;
  return 0;
}

// ============================================================================
// Cap check
// ============================================================================

export interface CapCheckResult {
  readonly allowed: boolean;
  /**
   * When false: the request is capped (would be the 7th session or 4th turn).
   * Caller must emit cap_exceeded to get the capped terminal state.
   */
  readonly reason?: 'session_cap' | 'turn_cap';
}

/**
 * Returns whether a *new* handoff is allowed given the current counters and
 * caps.
 *
 * "After the 6th legal session handoff, the current legal occupancy may
 * finish (including to done).  Only the 7th handoff request is capped."
 * Same idea for per-turn cap 3.
 */
export function checkHandoffCap(
  counters: HandoffCounters,
  sessionCap: number = DEFAULT_SESSION_CAP,
  turnCap: number = DEFAULT_TURN_CAP,
): CapCheckResult {
  if (counters.sessionHandoffs >= sessionCap) {
    return { allowed: false, reason: 'session_cap' };
  }
  if (counters.turnHandoffs >= turnCap) {
    return { allowed: false, reason: 'turn_cap' };
  }
  return { allowed: true };
}

// ============================================================================
// Core transition function
// ============================================================================

export type TransitionOk = {
  ok: true;
  next: HandoffKernelState;
  /** Whether this transition incremented the global handoff counter. */
  counted: boolean;
};
export type TransitionErr = {
  ok: false;
  error: string;
};
export type TransitionResult = TransitionOk | TransitionErr;

/**
 * Apply a single event to the kernel state.
 *
 * Rules:
 * 1. Terminal states never transition — returns error.
 * 2. If the event increments the counter, pre-check cap against CURRENT
 *    counters; if over cap, the caller should use cap_exceeded instead.
 *    (applyTransition does NOT auto-redirect; it validates and applies exactly
 *    the requested transition so tests can observe correct rejection messages.)
 * 3. The coordinator_resumed edge from awaiting_coordinator counts +1
 *    against the granted quota but the same counter field is used here for
 *    simplicity.  The host is responsible for deducting from the granted
 *    quota separately.
 *
 * @param state  Current kernel state.
 * @param event  Requested transition event.
 * @param now    ISO-8601 timestamp for the new state's enteredAt.
 * @param newTurnNumber  Optional; when provided, resets turnHandoffs to 0
 *                       (used at turn boundaries by the host).
 */
export function applyTransition(
  state: HandoffKernelState,
  event: HandoffEvent,
  now: string,
  newTurnNumber?: number,
): TransitionResult {
  const { state: from } = state;

  // Terminal states have no outgoing edges.
  const TERMINAL_STATES: readonly HandoffTerminalState[] = [
    'answered', 'done', 'capped', 'failed', 'cancelled', 'timed_out',
  ];
  if ((TERMINAL_STATES as readonly HandoffState[]).includes(from)) {
    return {
      ok: false,
      error: `[HandoffKernel] Terminal state ${from} has no outgoing edges; event ${event} rejected.`,
    };
  }

  const toState = (TRANSITIONS[from] as Partial<Record<HandoffEvent, HandoffState>> | undefined)?.[event];
  if (!toState) {
    return {
      ok: false,
      error: `[HandoffKernel] Illegal transition: ${from} --${event}--> (no such edge).`,
    };
  }

  const delta = handoffIncrement(from, event);
  const counted = delta === 1;

  // Compute new counters.
  const baseTurnHandoffs = newTurnNumber !== undefined ? 0 : state.counters.turnHandoffs;
  const newCounters: HandoffCounters = counted
    ? {
        sessionHandoffs: state.counters.sessionHandoffs + 1,
        turnHandoffs: baseTurnHandoffs + 1,
      }
    : {
        sessionHandoffs: state.counters.sessionHandoffs,
        turnHandoffs: baseTurnHandoffs,
      };

  const nextTurn = newTurnNumber !== undefined ? newTurnNumber : state.turnNumber;

  return {
    ok: true,
    counted,
    next: {
      state: toState,
      plan: state.plan,
      counters: newCounters,
      enteredAt: now,
      turnNumber: nextTurn,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns true if the state is terminal (no outgoing edges; task
 * termination).
 *
 * Per spec: kernel `done` is LOCAL completion only.  It is NOT deliver y
 * success.  answered/capped/failed/cancelled/timed_out/awaiting_coordinator
 * are NEVER mapped to implement delivery success.
 */
export function isTerminal(state: HandoffState): state is HandoffTerminalState {
  return (
    state === 'answered' ||
    state === 'done' ||
    state === 'capped' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'timed_out'
  );
}

export function isSuspended(state: HandoffState): state is HandoffSuspendState {
  return state === 'awaiting_coordinator';
}

export function isActive(state: HandoffState): state is HandoffActiveState {
  return (
    state === 'planner_readonly' ||
    state === 'plan_ready' ||
    state === 'executor_write' ||
    state === 'planner_repair'
  );
}

/** All known states in a stable order (useful for exhaustive tests). */
export const ALL_STATES: readonly HandoffState[] = [
  'planner_readonly',
  'plan_ready',
  'executor_write',
  'planner_repair',
  'awaiting_coordinator',
  'answered',
  'done',
  'capped',
  'failed',
  'cancelled',
  'timed_out',
];

/** All known events. */
export const ALL_EVENTS: readonly HandoffEvent[] = [
  'direct_answer',
  'submit_plan',
  'escalate_no_plan',
  'activate_executor',
  'pin_failed',
  'budget_insufficient',
  'local_done',
  'friction',
  'coordinator_resumed',
  'coordinator_no_plan',
  'coordinator_repair',
  'cap_exceeded',
  'fail',
  'cancel',
  'timeout',
  'escalate',
];

/**
 * Create the initial kernel state for a new session / new handoff-enabled
 * turn.  Entering planner_readonly is NOT a handoff.
 */
export function createInitialKernelState(opts: {
  now: string;
  turnNumber?: number;
}): HandoffKernelState {
  return {
    state: 'planner_readonly',
    plan: null,
    counters: { sessionHandoffs: 0, turnHandoffs: 0 },
    enteredAt: opts.now,
    turnNumber: opts.turnNumber ?? 1,
  };
}

/**
 * Reset turn-level handoff counter (called at each new turn by the host).
 * Session counter is preserved.
 */
export function resetTurnCounter(
  state: HandoffKernelState,
  newTurnNumber: number,
  now: string,
): HandoffKernelState {
  return {
    ...state,
    counters: {
      sessionHandoffs: state.counters.sessionHandoffs,
      turnHandoffs: 0,
    },
    turnNumber: newTurnNumber,
    enteredAt: now,
  };
}

/**
 * Enumerate all legal transitions in a stable order (for documentation /
 * exhaustive tests).
 */
export function listAllTransitions(): Array<{
  from: HandoffState;
  event: HandoffEvent;
  to: HandoffState;
}> {
  const out: Array<{ from: HandoffState; event: HandoffEvent; to: HandoffState }> = [];
  for (const from of ALL_STATES) {
    const row = TRANSITIONS[from];
    if (!row) continue;
    for (const event of ALL_EVENTS) {
      const to = (row as Partial<Record<HandoffEvent, HandoffState>>)[event];
      if (to) out.push({ from, event, to });
    }
  }
  return out;
}

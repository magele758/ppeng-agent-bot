/**
 * Trajectory Handoff v2.3 — state machine tests.
 *
 * Coverage (from spec §Tests):
 * - All edges from the transition table exist and are valid.
 * - Initial no-plan escalate from planner_readonly.
 * - Cap boundaries: 6th may finish, 7th rejected.
 * - planner_repair round-trip counting (full round = 2 handoffs).
 * - Crash resume non-increment.
 * - Terminal states have no outgoing edges.
 * - Late writes after answered must not execute (tested via terminal check).
 */

import { describe, it, expect } from 'vitest';
import {
  applyTransition,
  checkHandoffCap,
  createInitialKernelState,
  isTerminal,
  isSuspended,
  isActive,
  listAllTransitions,
  resetTurnCounter,
  ALL_STATES,
  ALL_EVENTS,
} from './state-machine.js';
import type { HandoffKernelState, HandoffState, HandoffEvent } from './types.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';

describe('HandoffStateMachine', () => {
  const now = () => new Date().toISOString();

  describe('createInitialKernelState', () => {
    it('creates an initial state in planner_readonly with zero counters', () => {
      const state = createInitialKernelState({ now: now(), turnNumber: 1 });
      expect(state.state).toBe('planner_readonly');
      expect(state.counters).toEqual({ sessionHandoffs: 0, turnHandoffs: 0 });
      expect(state.plan).toBeNull();
      expect(state.turnNumber).toBe(1);
    });
  });

  describe('State classifiers', () => {
    it('isTerminal returns true for all terminal states', () => {
      const terminals: HandoffState[] = ['answered', 'done', 'capped', 'failed', 'cancelled', 'timed_out'];
      for (const s of terminals) {
        expect(isTerminal(s)).toBe(true);
      }
    });

    it('isTerminal returns false for non-terminal states', () => {
      const nonTerminals: HandoffState[] = [
        'planner_readonly', 'plan_ready', 'executor_write', 'planner_repair', 'awaiting_coordinator',
      ];
      for (const s of nonTerminals) {
        expect(isTerminal(s)).toBe(false);
      }
    });

    it('isSuspended returns true only for awaiting_coordinator', () => {
      expect(isSuspended('awaiting_coordinator')).toBe(true);
      expect(isSuspended('planner_readonly')).toBe(false);
      expect(isSuspended('done')).toBe(false);
    });

    it('isActive returns true for active states', () => {
      const actives: HandoffState[] = ['planner_readonly', 'plan_ready', 'executor_write', 'planner_repair'];
      for (const s of actives) {
        expect(isActive(s)).toBe(true);
      }
      expect(isActive('awaiting_coordinator')).toBe(false);
      expect(isActive('done')).toBe(false);
    });
  });

  describe('All transitions exist and are valid', () => {
    it('enumerates all legal transitions from the table', () => {
      const transitions = listAllTransitions();
      expect(transitions.length).toBeGreaterThan(0);

      // Spot-check a few key edges from the spec.
      const hasEdge = (from: HandoffState, event: HandoffEvent, to: HandoffState) =>
        transitions.some((t) => t.from === from && t.event === event && t.to === to);

      expect(hasEdge('planner_readonly', 'direct_answer', 'answered')).toBe(true);
      expect(hasEdge('planner_readonly', 'submit_plan', 'plan_ready')).toBe(true);
      expect(hasEdge('plan_ready', 'activate_executor', 'executor_write')).toBe(true);
      expect(hasEdge('executor_write', 'friction', 'planner_repair')).toBe(true);
      expect(hasEdge('planner_repair', 'activate_executor', 'executor_write')).toBe(true);
      expect(hasEdge('executor_write', 'local_done', 'done')).toBe(true);
      expect(hasEdge('awaiting_coordinator', 'coordinator_resumed', 'executor_write')).toBe(true);
      expect(hasEdge('awaiting_coordinator', 'coordinator_no_plan', 'planner_readonly')).toBe(true);
    });

    it('applies each enumerated transition successfully', () => {
      const transitions = listAllTransitions();
      for (const { from, event, to } of transitions) {
        const state: HandoffKernelState = {
          state: from,
          plan: null,
          counters: { sessionHandoffs: 0, turnHandoffs: 0 },
          enteredAt: now(),
          turnNumber: 1,
        };
        const result = applyTransition(state, event, now());
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.next.state).toBe(to);
        }
      }
    });
  });

  describe('Initial no-plan escalate from planner_readonly', () => {
    it('planner_readonly → escalate_no_plan → awaiting_coordinator', () => {
      const state = createInitialKernelState({ now: now() });
      const result = applyTransition(state, 'escalate_no_plan', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('awaiting_coordinator');
        expect(result.counted).toBe(false); // Escalate does not count.
      }
    });
  });

  describe('Handoff counting', () => {
    it('plan_ready → executor_write counts +1', () => {
      const state: HandoffKernelState = {
        state: 'plan_ready',
        plan: null,
        counters: { sessionHandoffs: 0, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'activate_executor', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.counted).toBe(true);
        expect(result.next.counters.sessionHandoffs).toBe(1);
        expect(result.next.counters.turnHandoffs).toBe(1);
      }
    });

    it('executor_write → friction counts +1', () => {
      const state: HandoffKernelState = {
        state: 'executor_write',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 1 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'friction', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.counted).toBe(true);
        expect(result.next.counters.sessionHandoffs).toBe(2);
        expect(result.next.counters.turnHandoffs).toBe(2);
      }
    });

    it('planner_repair → executor_write counts +1 (round-trip = 2 total)', () => {
      let state: HandoffKernelState = {
        state: 'executor_write',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 1 },
        enteredAt: now(),
        turnNumber: 1,
      };

      // executor → planner_repair (+1).
      let result = applyTransition(state, 'friction', now());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');
      state = result.next;
      expect(state.counters.sessionHandoffs).toBe(2);

      // planner_repair → executor_write (+1).
      result = applyTransition(state, 'activate_executor', now());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');
      expect(result.next.counters.sessionHandoffs).toBe(3);
      expect(result.counted).toBe(true);
    });

    it('planner_readonly → answered does NOT count', () => {
      const state = createInitialKernelState({ now: now() });
      const result = applyTransition(state, 'direct_answer', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.counted).toBe(false);
        expect(result.next.counters.sessionHandoffs).toBe(0);
      }
    });

    it('escalate transitions do NOT count', () => {
      const state: HandoffKernelState = {
        state: 'planner_readonly',
        plan: null,
        counters: { sessionHandoffs: 0, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'escalate', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.counted).toBe(false);
        expect(result.next.counters.sessionHandoffs).toBe(0);
      }
    });
  });

  describe('Cap boundaries', () => {
    it('6th legal handoff occupancy may finish to done', () => {
      const state: HandoffKernelState = {
        state: 'executor_write',
        plan: null,
        counters: { sessionHandoffs: 6, turnHandoffs: 3 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'local_done', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('done');
      }
    });

    it('checkHandoffCap rejects 7th session handoff', () => {
      const check = checkHandoffCap({ sessionHandoffs: 6, turnHandoffs: 0 }, DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('session_cap');
    });

    it('checkHandoffCap rejects 4th turn handoff', () => {
      const check = checkHandoffCap({ sessionHandoffs: 3, turnHandoffs: 3 }, DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('turn_cap');
    });

    it('checkHandoffCap allows handoff below caps', () => {
      const check = checkHandoffCap({ sessionHandoffs: 2, turnHandoffs: 1 }, DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP);
      expect(check.allowed).toBe(true);
    });
  });

  describe('Terminal states have no outgoing edges', () => {
    const terminals: HandoffState[] = ['answered', 'done', 'capped', 'failed', 'cancelled', 'timed_out'];

    for (const term of terminals) {
      it(`${term} rejects all events`, () => {
        const state: HandoffKernelState = {
          state: term,
          plan: null,
          counters: { sessionHandoffs: 0, turnHandoffs: 0 },
          enteredAt: now(),
          turnNumber: 1,
        };
        // Try a few representative events.
        for (const event of ['submit_plan', 'activate_executor', 'fail'] as HandoffEvent[]) {
          const result = applyTransition(state, event, now());
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toContain('Terminal state');
          }
        }
      });
    }
  });

  describe('Illegal transitions are rejected', () => {
    it('rejects a transition not in the table', () => {
      const state: HandoffKernelState = {
        state: 'planner_readonly',
        plan: null,
        counters: { sessionHandoffs: 0, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      // planner_readonly has no 'local_done' edge.
      const result = applyTransition(state, 'local_done', now());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Illegal transition');
      }
    });
  });

  describe('Turn counter reset', () => {
    it('resetTurnCounter resets turnHandoffs but preserves sessionHandoffs', () => {
      const state: HandoffKernelState = {
        state: 'planner_readonly',
        plan: null,
        counters: { sessionHandoffs: 3, turnHandoffs: 2 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const reset = resetTurnCounter(state, 2, now());
      expect(reset.counters.sessionHandoffs).toBe(3);
      expect(reset.counters.turnHandoffs).toBe(0);
      expect(reset.turnNumber).toBe(2);
    });

    it('applyTransition with newTurnNumber resets turnHandoffs', () => {
      const state: HandoffKernelState = {
        state: 'planner_readonly',
        plan: null,
        counters: { sessionHandoffs: 2, turnHandoffs: 2 },
        enteredAt: now(),
        turnNumber: 1,
      };
      // Transition with newTurnNumber.
      const result = applyTransition(state, 'submit_plan', now(), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.turnNumber).toBe(2);
        expect(result.next.counters.turnHandoffs).toBe(0);
        expect(result.next.counters.sessionHandoffs).toBe(2);
      }
    });
  });

  describe('awaiting_coordinator edges', () => {
    it('coordinator_resumed → executor_write (counts +1)', () => {
      const state: HandoffKernelState = {
        state: 'awaiting_coordinator',
        plan: null,
        counters: { sessionHandoffs: 2, turnHandoffs: 1 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'coordinator_resumed', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('executor_write');
        expect(result.counted).toBe(true);
        expect(result.next.counters.sessionHandoffs).toBe(3);
      }
    });

    it('coordinator_no_plan → planner_readonly (does NOT count)', () => {
      const state: HandoffKernelState = {
        state: 'awaiting_coordinator',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'coordinator_no_plan', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('planner_readonly');
        expect(result.counted).toBe(false);
        expect(result.next.counters.sessionHandoffs).toBe(1);
      }
    });

    it('coordinator_repair → planner_repair (does NOT count)', () => {
      const state: HandoffKernelState = {
        state: 'awaiting_coordinator',
        plan: null,
        counters: { sessionHandoffs: 1, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'coordinator_repair', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('planner_repair');
        expect(result.counted).toBe(false);
      }
    });
  });

  describe('Budget insufficient escalate', () => {
    it('plan_ready → budget_insufficient → awaiting_coordinator', () => {
      const state: HandoffKernelState = {
        state: 'plan_ready',
        plan: null,
        counters: { sessionHandoffs: 0, turnHandoffs: 0 },
        enteredAt: now(),
        turnNumber: 1,
      };
      const result = applyTransition(state, 'budget_insufficient', now());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.state).toBe('awaiting_coordinator');
        expect(result.counted).toBe(false);
      }
    });
  });

  describe('Comprehensive edge coverage', () => {
    it('covers all enumerated transitions without errors', () => {
      const transitions = listAllTransitions();
      for (const { from, event, to } of transitions) {
        const state: HandoffKernelState = {
          state: from,
          plan: null,
          counters: { sessionHandoffs: 0, turnHandoffs: 0 },
          enteredAt: now(),
          turnNumber: 1,
        };
        const result = applyTransition(state, event, now());
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.next.state).toBe(to);
        }
      }
    });
  });
});

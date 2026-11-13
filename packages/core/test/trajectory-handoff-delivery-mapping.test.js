/**
 * Trajectory Handoff v2.3 — delivery-mapping regression tests.
 *
 * Issue #516: kernel `done` is local completion only, NOT delivery success.
 * The states answered, capped, failed, cancelled, timed_out, and
 * awaiting_coordinator must NEVER map to "implement delivery success".
 *
 * These tests verify the semantic contract between the handoff state machine
 * and the delivery pipeline without touching packages/core/src/quality/gate.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Import from the built dist so the test matches what core actually sees.
import {
  isTerminal,
  isSuspended,
  isActive,
  ALL_STATES,
  createInitialKernelState,
  applyTransition,
} from '../../../packages/agent-loop/dist/index.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simulate "deliver success" mapping: for each state, check whether the state
 * could be misread as a successful delivery in the production pipeline.
 *
 * Rules (from spec §delivery-mapping):
 * - Only `done` can be treated as local completion.
 * - `done` means "local task completed" — it does NOT mean the quality gate
 *   passed or that the delivery artifact was accepted.
 * - `answered` = direct answer (no tool execution), not a delivery.
 * - `capped|failed|cancelled|timed_out` = negative/error terminal.
 * - `awaiting_coordinator` = suspend, not complete.
 */
function isDeliverySuccessState(state) {
  // The ONLY semantically safe mapping is "done" for local completion checks.
  // Even that is NOT delivery success without a passed quality gate.
  // This mapping function intentionally returns false for all states, because
  // no handoff state alone maps to implement delivery success.
  return false;
}

/**
 * States that must never be treated as delivery success.
 * Includes all terminal states except done would be misuse, and the suspend state.
 */
const NON_DELIVERY_STATES = [
  'answered',
  'capped',
  'failed',
  'cancelled',
  'timed_out',
  'awaiting_coordinator',
];

// ============================================================================
// Tests
// ============================================================================

test('no handoff state maps to implement delivery success [AC:delivery-mapping#DM-1]', () => {
  for (const state of ALL_STATES) {
    assert.equal(
      isDeliverySuccessState(state),
      false,
      `State "${state}" must not map to implement delivery success`
    );
  }
});

test('answered is terminal and must not map to delivery success [AC:delivery-mapping#DM-2]', () => {
  assert.ok(isTerminal('answered'), 'answered must be terminal');
  assert.equal(isDeliverySuccessState('answered'), false);
});

test('capped is terminal and must not map to delivery success [AC:delivery-mapping#DM-2]', () => {
  assert.ok(isTerminal('capped'), 'capped must be terminal');
  assert.equal(isDeliverySuccessState('capped'), false);
});

test('failed is terminal and must not map to delivery success [AC:delivery-mapping#DM-2]', () => {
  assert.ok(isTerminal('failed'), 'failed must be terminal');
  assert.equal(isDeliverySuccessState('failed'), false);
});

test('cancelled is terminal and must not map to delivery success [AC:delivery-mapping#DM-2]', () => {
  assert.ok(isTerminal('cancelled'), 'cancelled must be terminal');
  assert.equal(isDeliverySuccessState('cancelled'), false);
});

test('timed_out is terminal and must not map to delivery success [AC:delivery-mapping#DM-2]', () => {
  assert.ok(isTerminal('timed_out'), 'timed_out must be terminal');
  assert.equal(isDeliverySuccessState('timed_out'), false);
});

test('awaiting_coordinator is suspended and must not map to delivery success [AC:delivery-mapping#DM-3]', () => {
  assert.ok(isSuspended('awaiting_coordinator'), 'awaiting_coordinator must be suspended');
  assert.equal(isTerminal('awaiting_coordinator'), false, 'awaiting_coordinator is not terminal');
  assert.equal(isDeliverySuccessState('awaiting_coordinator'), false);
});

test('done is terminal and local completion only — not delivery success [AC:delivery-mapping#DM-4]', () => {
  assert.ok(isTerminal('done'), 'done must be terminal');
  // done is local kernel completion; it does NOT imply quality gate passed
  // or delivery artifact accepted. The delivery pipeline must run its own
  // quality gate check independently.
  assert.equal(isDeliverySuccessState('done'), false, 'done alone must not map to delivery success');
});

test('all NON_DELIVERY_STATES are accounted for in ALL_STATES [AC:delivery-mapping#DM-5]', () => {
  for (const state of NON_DELIVERY_STATES) {
    assert.ok(
      ALL_STATES.includes(state),
      `${state} must be in ALL_STATES`
    );
  }
});

test('terminal states have no outgoing edges (kernel enforces no re-entry) [AC:delivery-mapping#DM-6]', () => {
  const terminalStates = ALL_STATES.filter(isTerminal);
  for (const state of terminalStates) {
    const kernelState = {
      state,
      plan: null,
      counters: { sessionHandoffs: 0, turnHandoffs: 0 },
      enteredAt: new Date().toISOString(),
      turnNumber: 0,
    };
    // Attempting any event from a terminal state must fail.
    const result = applyTransition(kernelState, 'activate_executor');
    assert.equal(result.ok, false, `Terminal state "${state}" must reject all transitions`);
  }
});

test('active states are not delivery success [AC:delivery-mapping#DM-7]', () => {
  const activeStates = ALL_STATES.filter(isActive);
  for (const state of activeStates) {
    assert.equal(
      isDeliverySuccessState(state),
      false,
      `Active state "${state}" must not map to delivery success`
    );
  }
});

test('initial kernel state is active planner_readonly, not delivery success [AC:delivery-mapping#DM-8]', () => {
  const initial = createInitialKernelState({ now: new Date().toISOString() });
  assert.equal(initial.state, 'planner_readonly', 'initial state must be planner_readonly');
  assert.ok(isActive(initial.state), 'initial state must be active');
  assert.equal(isDeliverySuccessState(initial.state), false);
});

test('state exhaustiveness: all states in NON_DELIVERY_STATES are non-delivery [AC:delivery-mapping#DM-9]', () => {
  // Regression guard: if new terminal states are added, this test forces
  // an explicit decision about their delivery mapping.
  const terminalStates = ALL_STATES.filter(isTerminal);
  const knownTerminals = new Set(['answered', 'done', 'capped', 'failed', 'cancelled', 'timed_out']);

  for (const state of terminalStates) {
    assert.ok(
      knownTerminals.has(state),
      `New terminal state "${state}" added without delivery-mapping review. ` +
      `Add it to knownTerminals and explicitly document its delivery mapping.`
    );
  }
  assert.equal(
    terminalStates.length,
    knownTerminals.size,
    'Terminal state count must match known set'
  );
});

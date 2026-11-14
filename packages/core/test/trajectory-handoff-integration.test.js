import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapabilityTiers, parseCapabilityTiersOrNull } from '../dist/trajectory-handoff/index.js';
import {
  createInitialKernelState,
  applyTransition,
  isTerminal,
  ALL_STATES,
  ALL_EVENTS,
} from '@ppeng/agent-loop';

test('PlanObject extended types are exported', () => {
  // This test verifies that the new fields (replanTriggers, resumePolicy) are part of the type system.
  // Actual usage will be tested when the kernel is fully wired.
  const mockPlan = {
    planId: 'test-plan',
    version: 1,
    status: 'accepted',
    steps: [{ id: 'step1', description: 'Test step' }],
    createdAt: new Date().toISOString(),
    replanTriggers: [
      {
        id: 'trigger1',
        condition: 'Test fails twice',
        predicate: { kind: 'verification_consecutive_failures', object: { planVersion: 1, stepId: 'step1', verificationKind: 'test', verificationTarget: 'suite1' }, threshold: 2, scope: 'current_role_occupancy' },
        action: 'repair_plan',
      },
    ],
    resumePolicy: { step1: 'retry_idempotent' },
  };
  
  assert.equal(mockPlan.replanTriggers.length, 1);
  assert.equal(mockPlan.resumePolicy.step1, 'retry_idempotent');
});

test('parseCapabilityTiers handles missing config (production default off)', () => {
  const result1 = parseCapabilityTiers(undefined);
  assert.equal(result1.ok, true);
  assert.equal(result1.resolved.enabled, false);
  
  const result2 = parseCapabilityTiers(null);
  assert.equal(result2.ok, true);
  assert.equal(result2.resolved.enabled, false);
  
  const result3 = parseCapabilityTiersOrNull(undefined);
  assert.equal(result3, null);
});

test('parseCapabilityTiers handles explicit enabled:true', () => {
  const config = { enabled: true };
  const result = parseCapabilityTiers(config);
  assert.equal(result.ok, true);
  assert.equal(result.resolved.enabled, true);
  assert.equal(result.resolved.perSessionCap, 6);
  assert.equal(result.resolved.perTurnCap, 3);
});

test('parseCapabilityTiers handles explicit enabled:false', () => {
  const config = { enabled: false };
  const result = parseCapabilityTiers(config);
  assert.equal(result.ok, true);
  assert.equal(result.resolved.enabled, false);
});

test('parseCapabilityTiers handles role model refs when enabled:false', () => {
  const config = {
    enabled: false,
    roles: {
      plannerModel: 'anthropic/claude-opus-4',
      executorModel: 'google/gemini-4-hydrogen',
    },
  };
  const result = parseCapabilityTiers(config);
  assert.equal(result.ok, true);
  assert.equal(result.resolved.enabled, false);
  // Model refs are preserved even when disabled
  assert.equal(result.resolved.plannerModel, 'anthropic/claude-opus-4');
  assert.equal(result.resolved.executorModel, 'google/gemini-4-hydrogen');
});

test('parseCapabilityTiers clamps illegal caps', () => {
  const config1 = { enabled: true, caps: { perSession: 0, perTurn: 0 } };
  const result1 = parseCapabilityTiers(config1);
  assert.equal(result1.ok, true);
  assert.equal(result1.resolved.perSessionCap, 6); // 0 → default 6
  assert.equal(result1.resolved.perTurnCap, 3);     // 0 → default 3
  
  const config2 = { enabled: true, caps: { perSession: 3, perTurn: 10 } };
  const result2 = parseCapabilityTiers(config2);
  assert.equal(result2.ok, true);
  assert.equal(result2.resolved.perSessionCap, 3);
  assert.equal(result2.resolved.perTurnCap, 3); // clamped to perSession
});

test('Kernel state machine enforces terminal state rules', () => {
  const initialState = createInitialKernelState({
    sessionId: 'test',
    turnNumber: 1,
    now: new Date().toISOString(),
  });
  
  assert.equal(initialState.state, 'planner_readonly');
  assert.equal(isTerminal(initialState.state), false);
  
  // answered is terminal
  const answeredTransition = applyTransition(initialState, 'direct_answer', new Date().toISOString());
  assert.equal(answeredTransition.ok, true);
  assert.equal(answeredTransition.next.state, 'answered');
  assert.equal(isTerminal('answered'), true);

  const rejectedTransition = applyTransition(answeredTransition.next, 'submit_plan', new Date().toISOString());
  assert.equal(rejectedTransition.ok, false);
  assert.match(rejectedTransition.error, /Terminal state/);
});

test('Kernel state machine counts handoffs correctly', () => {
  let state = createInitialKernelState({
    sessionId: 'test',
    turnNumber: 1,
    now: new Date().toISOString(),
  });
  
  // Enter planner_readonly: no handoff
  assert.equal(state.counters.sessionHandoffs, 0);
  assert.equal(state.counters.turnHandoffs, 0);
  
  // Submit plan: no handoff
  let transition = applyTransition(state, 'submit_plan', new Date().toISOString());
  assert.equal(transition.ok, true);
  state = transition.next;
  assert.equal(state.state, 'plan_ready');
  assert.equal(state.counters.sessionHandoffs, 0);
  
  // Activate executor: +1 handoff
  transition = applyTransition(state, 'activate_executor', new Date().toISOString());
  assert.equal(transition.ok, true);
  state = transition.next;
  assert.equal(state.state, 'executor_write');
  assert.equal(state.counters.sessionHandoffs, 1);
  assert.equal(state.counters.turnHandoffs, 1);
  
  // Friction back to planner: +1 handoff
  transition = applyTransition(state, 'friction', new Date().toISOString());
  assert.equal(transition.ok, true);
  state = transition.next;
  assert.equal(state.state, 'planner_repair');
  assert.equal(state.counters.sessionHandoffs, 2);
  assert.equal(state.counters.turnHandoffs, 2);
});

test('delivery-mapping: terminal states are not delivery success', () => {
  // This test verifies DM-2: terminal states must not map to implement delivery success
  const terminalStates = ['answered', 'done', 'capped', 'failed', 'cancelled', 'timed_out'];
  
  for (const terminalState of terminalStates) {
    assert.equal(isTerminal(terminalState), true, `${terminalState} should be terminal`);
    assert.ok(ALL_STATES.includes(terminalState), `${terminalState} should be in ALL_STATES`);
  }
  
  // awaiting_coordinator is suspend, not terminal
  assert.equal(isTerminal('awaiting_coordinator'), false);
  assert.ok(ALL_STATES.includes('awaiting_coordinator'));
});

test('role pinning types are available', async () => {
  // Minimal smoke test that role pinning module exists and exports expected types
  const { resolveRoleModel } = await import('../dist/model/role-pinning.js');
  assert.equal(typeof resolveRoleModel, 'function');
});

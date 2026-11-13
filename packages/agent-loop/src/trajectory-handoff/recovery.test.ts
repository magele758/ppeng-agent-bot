/**
 * Trajectory Handoff v2.3 - Persistence & Crash Recovery Tests
 *
 * Tests for Codex R1 (deadline precedence) and R2 (crash-conserving budget).
 * Must pass all four acceptance criteria:
 * 1. Resume rejects if persisted deadline already reached even if timeout txn not committed
 * 2. Approved call without persisted result still counts once after reconcile
 * 3. Unknown runtime tail billed conservatively into used time
 * 4. Intent without result → unknown, no auto-replay, irreconcilable → failed
 */

import { describe, it, expect } from 'vitest';
import type {
  PersistedCallIntent,
  PersistedCallResult,
  PersistedHandoffState,
  ReconciliationContext,
} from './recovery.js';
import {
  checkDeadlineR1,
  reconcileCallBudgetR2,
  recoverFromCrash,
} from './recovery.js';

describe('Codex R1: Persisted deadline vs timeout transaction', () => {
  const baseState: PersistedHandoffState = {
    state: 'executor_write',
    handoffCountCommitted: 1,
    perTurnCountCommitted: 1,
    sessionUsedMs: 100,
    turnUsedMs: 50,
    terminalState: null,
    persistedAt: 1000,
  };

  it('AC1.1: Resume rejects if session deadline already reached', () => {
    const nowMs = 5000;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: 4000, // Already passed
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(false);
  });

  it('AC1.2: Resume rejects if turn deadline already reached', () => {
    const nowMs = 5000;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: null,
      turnDeadlineMs: 4000, // Already passed
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(false);
  });

  it('AC1.3: Resume rejects if role activity deadline already reached', () => {
    const nowMs = 5000;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: 4000, // Already passed
      terminalStateCommitted: false,
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(false);
  });

  it('AC1.4: Resume rejects even if timeout txn not yet committed', () => {
    const nowMs = 5000;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: 4000,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false, // NOT committed yet
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(false);
  });

  it('AC1.5: Resume rejects if terminal state already committed', () => {
    const nowMs = 1500; // Well before all deadlines
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: 10000,
      turnDeadlineMs: 10000,
      roleActivityDeadlineMs: 10000,
      terminalStateCommitted: true, // Already terminal
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(false);
  });

  it('AC1.6: Resume allowed when all deadlines still active', () => {
    const nowMs = 1500;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: 5000,
      turnDeadlineMs: 5000,
      roleActivityDeadlineMs: 5000,
      terminalStateCommitted: false,
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(true);
  });

  it('AC1.7: Resume allowed when deadlines are null (no deadline set)', () => {
    const nowMs = 9999;
    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [],
      uncommittedResults: [],
      nowMs,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const allowed = checkDeadlineR1(ctx);
    expect(allowed).toBe(true);
  });
});

describe('Codex R2: Crash-conserving call budget', () => {
  const baseState: PersistedHandoffState = {
    state: 'executor_write',
    handoffCountCommitted: 1,
    perTurnCountCommitted: 1,
    sessionUsedMs: 100,
    turnUsedMs: 50,
    terminalState: null,
    persistedAt: 1000,
  };

  const maxRuntimeMs = 5000;

  it('AC2.1: Approved call without persisted result still counts once after reconcile', () => {
    // Intent exists, result persists as ok
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'ok',
      runtimeMsActual: 200,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent],
      uncommittedResults: [result],
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    expect(reconciled.reconciled).toBe(true);
    // Count should increment by 1 (one result with ok outcome)
    expect(reconciled.handoffCountAfterReconcile).toBe(baseState.handoffCountCommitted + 1);
    expect(reconciled.perTurnCountAfterReconcile).toBe(baseState.perTurnCountCommitted + 1);
    // Used time increases by actual runtime
    expect(reconciled.sessionUsedMsAfterReconcile).toBe(baseState.sessionUsedMs + 200);
    expect(reconciled.turnUsedMsAfterReconcile).toBe(baseState.turnUsedMs + 200);
    expect(reconciled.unknownOutcomeCalls).toHaveLength(0);
  });

  it('AC2.2: Approved call with multiple results reconciles separately', () => {
    const intent1: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const intent2: PersistedCallIntent = {
      callId: 'call-2',
      approvedAt: 1150,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 300,
      turnUsedMsAtApproval: 250,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result1: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'ok',
      runtimeMsActual: 200,
    };

    const result2: PersistedCallResult = {
      callId: 'call-2',
      outcome: 'error',
      errorMessage: 'Network error',
      runtimeMsActual: 150,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent1, intent2],
      uncommittedResults: [result1, result2],
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    expect(reconciled.reconciled).toBe(true);
    // Both results committed: count increases by 2
    expect(reconciled.handoffCountAfterReconcile).toBe(baseState.handoffCountCommitted + 2);
    expect(reconciled.perTurnCountAfterReconcile).toBe(baseState.perTurnCountCommitted + 2);
    // Used time increases by sum of runtimes
    expect(reconciled.sessionUsedMsAfterReconcile).toBe(baseState.sessionUsedMs + 200 + 150);
    expect(reconciled.turnUsedMsAfterReconcile).toBe(baseState.turnUsedMs + 200 + 150);
  });

  it('AC2.3: Unknown runtime tail billed conservatively', () => {
    // Intent exists but NO result persisted: unknown outcome
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent],
      uncommittedResults: [], // No result: crash before result persisted
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    expect(reconciled.reconciled).toBe(true);
    // Count does NOT increment (unknown, not yet committed)
    expect(reconciled.handoffCountAfterReconcile).toBe(baseState.handoffCountCommitted);
    // But time IS billed conservatively (minimum tail)
    expect(reconciled.sessionUsedMsAfterReconcile).toBeGreaterThan(baseState.sessionUsedMs);
    expect(reconciled.turnUsedMsAfterReconcile).toBeGreaterThan(baseState.turnUsedMs);
    // Call must be marked unknown
    expect(reconciled.unknownOutcomeCalls).toContain('call-1');
  });

  it('AC2.4: Explicitly marked unknown outcome is not auto-replayed', () => {
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'unknown',
      runtimeMsActual: 75,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent],
      uncommittedResults: [result],
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    expect(reconciled.reconciled).toBe(true);
    // Count does NOT increment (unknown is not a committed outcome)
    expect(reconciled.handoffCountAfterReconcile).toBe(baseState.handoffCountCommitted);
    // Time IS billed
    expect(reconciled.sessionUsedMsAfterReconcile).toBe(baseState.sessionUsedMs + 75);
    // Must be in unknown list (no auto-replay)
    expect(reconciled.unknownOutcomeCalls).toContain('call-1');
  });

  it('AC2.5: Runtime exhaustion → timed_out terminal on reconciliation', () => {
    // Create an intent that would push us over the budget
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 4900,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'ok',
      runtimeMsActual: 500, // Would exceed 5000 total
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: {
        ...baseState,
        sessionUsedMs: 4900,
      },
      uncommittedIntents: [intent],
      uncommittedResults: [result],
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    expect(reconciled.reconciled).toBe(false);
    expect(reconciled.failureState).toBe('timed_out');
    expect(reconciled.failureReason).toContain('runtime exhausted');
  });

  it('AC2.6: Fail-closed if irreconcilable', () => {
    // Very large unknown tail that exceeds budget
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 4900,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: {
        ...baseState,
        sessionUsedMs: 4900,
      },
      uncommittedIntents: [intent],
      uncommittedResults: [], // Unknown outcome
      nowMs: 2000,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const reconciled = reconcileCallBudgetR2(ctx, maxRuntimeMs);
    // Even with conservative billing, total is > 5000
    expect(reconciled.reconciled).toBe(false);
    expect(reconciled.failureState).toBe('timed_out');
  });
});

describe('Full crash recovery (R1 + R2)', () => {
  const baseState: PersistedHandoffState = {
    state: 'executor_write',
    handoffCountCommitted: 1,
    perTurnCountCommitted: 1,
    sessionUsedMs: 100,
    turnUsedMs: 50,
    terminalState: null,
    persistedAt: 1000,
  };

  const maxRuntimeMs = 5000;

  it('AC3.1: R1 check rejects if deadline passed (stops before R2)', () => {
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent],
      uncommittedResults: [],
      nowMs: 5000, // Past deadline
      sessionDeadlineMs: 4000,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const result = recoverFromCrash(ctx, maxRuntimeMs);
    expect(result.reconciled).toBe(false);
    expect(result.failureState).toBe('timed_out');
    expect(result.failureReason).toContain('R1 rejection');
    expect(result.resumeRejected).toBe(true);
  });

  it('AC3.2: R2 processes when R1 passes', () => {
    const intent: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'ok',
      runtimeMsActual: 200,
    };

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent],
      uncommittedResults: [result],
      nowMs: 1500, // Before deadline
      sessionDeadlineMs: 5000,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const recovered = recoverFromCrash(ctx, maxRuntimeMs);
    expect(recovered.reconciled).toBe(true);
    expect(recovered.handoffCountAfterReconcile).toBe(2);
    expect(recovered.sessionUsedMsAfterReconcile).toBe(100 + 200);
  });

  it('AC3.3: Full crash recovery with multiple calls and mixed outcomes', () => {
    const intent1: PersistedCallIntent = {
      callId: 'call-1',
      approvedAt: 1100,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 100,
      turnUsedMsAtApproval: 50,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const intent2: PersistedCallIntent = {
      callId: 'call-2',
      approvedAt: 1150,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 300,
      turnUsedMsAtApproval: 250,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const intent3: PersistedCallIntent = {
      callId: 'call-3',
      approvedAt: 1200,
      handoffCountAtApproval: 1,
      perTurnCountAtApproval: 1,
      sessionUsedMsAtApproval: 500,
      turnUsedMsAtApproval: 450,
      sessionDeadlineMs: null,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
    };

    const result1: PersistedCallResult = {
      callId: 'call-1',
      outcome: 'ok',
      runtimeMsActual: 100,
    };

    const result2: PersistedCallResult = {
      callId: 'call-2',
      outcome: 'unknown', // Explicitly marked
      runtimeMsActual: 50,
    };
    // call-3 has no result: unknown from crash

    const ctx: ReconciliationContext = {
      lastPersistedState: baseState,
      uncommittedIntents: [intent1, intent2, intent3],
      uncommittedResults: [result1, result2],
      nowMs: 1500,
      sessionDeadlineMs: 5000,
      turnDeadlineMs: null,
      roleActivityDeadlineMs: null,
      terminalStateCommitted: false,
    };

    const recovered = recoverFromCrash(ctx, maxRuntimeMs);
    expect(recovered.reconciled).toBe(true);
    // Only call-1 counts toward handoff (ok outcome)
    expect(recovered.handoffCountAfterReconcile).toBe(2);
    // call-2 and call-3 marked unknown
    expect(recovered.unknownOutcomeCalls).toContain('call-2');
    expect(recovered.unknownOutcomeCalls).toContain('call-3');
  });
});

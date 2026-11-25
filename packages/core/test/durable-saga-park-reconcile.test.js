/**
 * Phase 3 Core integration tests: crash-safe mid-rollback Saga resume,
 * Pivot guard enforcement, parked signal wakeup across SQLite reopen,
 * and reconcile + manual operator resolution.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RawAgentRuntime,
  reconcileSessionUnknownSteps,
  resolveDurableStepManually,
  rollbackSessionToStep,
} from '../dist/exports/public.js';

function makeTempDirs(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const repoRoot = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { repoRoot, stateDir };
}

test('mid-rollback crash preserves rolling_back across SQLite reopen and scheduler finishes remaining LIFO compensations [AC:durable-saga-park-reconcile#AC-1]', async (t) => {
  const { repoRoot, stateDir } = makeTempDirs(t, 'p3-saga-crash-');

  const rt1 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'noop',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
  });
  const session = rt1.createChatSession({ title: 'saga-crash', message: 'do external ops', background: false });
  const run = rt1.store.durableJournal.beginRun({ runId: 'drun_mid_rb', sessionId: session.id });
  const s1 = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    kind: 'tool_call',
    toolCallId: 'c1',
    toolName: 'ext_draft',
    idempotencyKey: 'ik1',
    effectClass: 'external_compensatable',
    replayPolicy: 'unsafe',
  });
  rt1.store.durableJournal.markStepDispatched(s1.stepId);
  rt1.store.durableJournal.commitStep(s1.stepId, {
    compensationSpec: { kind: 'undo_draft', toolName: 'ext_draft', payload: { id: 'draft-1' } },
  });
  const s2 = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    kind: 'tool_call',
    toolCallId: 'c2',
    toolName: 'ext_branch',
    idempotencyKey: 'ik2',
    effectClass: 'external_compensatable',
    replayPolicy: 'unsafe',
  });
  rt1.store.durableJournal.markStepDispatched(s2.stepId);
  rt1.store.durableJournal.commitStep(s2.stepId, {
    compensationSpec: { kind: 'undo_branch', toolName: 'ext_branch', payload: { name: 'b-1' } },
  });

  // Simulate process killed mid-rollback: s2 already compensated, s1 still committed, run status = rolling_back
  rt1.store.durableJournal.updateRun(run.runId, { status: 'rolling_back' });
  rt1.store.durableJournal.updateStepPhase(s2.stepId, 'compensated');
  await rt1.destroy();

  // Process 2 boots with stateless tool compensators
  const compensated = [];
  const rt2 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'noop-2',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
    extraTools: [
      {
        name: 'ext_draft',
        description: 'external draft',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'external',
        effectClass: 'external_compensatable',
        execute: async () => ({ ok: true, content: 'ok' }),
        executeCompensation: async (_ctx, spec) => {
          compensated.push(spec.payload.id);
          return { ok: true };
        },
      },
      {
        name: 'ext_branch',
        description: 'external branch',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'external',
        effectClass: 'external_compensatable',
        execute: async () => ({ ok: true, content: 'ok' }),
        executeCompensation: async (_ctx, spec) => {
          compensated.push(spec.payload.name);
          return { ok: true };
        },
      },
    ],
  });
  t.after(() => rt2.destroy());

  // Boot recovery keeps rolling_back untouched until scheduler resumes it
  assert.equal(rt2.store.durableJournal.getRun(run.runId)?.status, 'rolling_back');

  await rt2.runScheduler();
  assert.deepEqual(compensated, ['draft-1']); // s2 NOT repeated; s1 completed!
  assert.equal(rt2.store.durableJournal.getRun(run.runId)?.status, 'rolled_back');
  assert.equal(rt2.store.durableJournal.getStep(s1.stepId)?.phase, 'compensated');
});

test('rollbackSessionToStep blocks across external_irreversible Pivot and allows explicit reconcile + operator resolve [AC:durable-saga-park-reconcile#AC-2] [AC:durable-saga-park-reconcile#AC-4]', async (t) => {
  const { repoRoot, stateDir } = makeTempDirs(t, 'p3-pivot-rec-');

  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'noop',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
    extraTools: [
      {
        name: 'remote_pay',
        description: 'irreversible payment',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'external',
        effectClass: 'external_irreversible',
        replay: 'unsafe',
        execute: async () => ({ ok: true, content: 'paid' }),
        reconcile: async () => ({ status: 'unknown' }),
      },
    ],
  });
  t.after(() => rt.destroy());

  const session = rt.createChatSession({ title: 'pivot', message: 'pay invoice', background: false });
  const run = rt.store.durableJournal.beginRun({ runId: 'drun_pivot_core', sessionId: session.id });
  rt.store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'tc_pay', name: 'remote_pay', input: {} },
  ]);
  const sPay = rt.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    kind: 'tool_call',
    toolCallId: 'tc_pay',
    toolName: 'remote_pay',
    idempotencyKey: 'ik_pay',
    effectClass: 'external_irreversible',
    replayPolicy: 'unsafe',
  });
  rt.store.durableJournal.markStepDispatched(sPay.stepId);
  rt.store.durableJournal.updateRun(run.runId, { passedPivot: true });
  rt.store.durableJournal.markStepUnknown(sPay.stepId, 'network_timeout');

  // Automatic rollback blocked by Pivot
  const blocked = await rollbackSessionToStep(rt.store, rt.workspaceTx, { sessionId: session.id });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockedByPivot, true);

  // Reconcile probe returns unknown -> run enters needs_reconcile
  const rec = await reconcileSessionUnknownSteps({
    store: rt.store,
    sessionId: session.id,
    repoRoot,
    stateDir,
    tools: rt.tools,
  });
  assert.deepEqual(rec.unresolvedStepIds, [sPay.stepId]);
  assert.equal(rt.store.durableJournal.getRun(run.runId)?.status, 'needs_reconcile');

  // Operator manually resolves step as committed -> tool_result paired and run returns to resumable
  const resolved = resolveDurableStepManually(rt.store, {
    sessionId: session.id,
    stepId: sPay.stepId,
    decision: 'committed',
    note: 'verified charge in Stripe dashboard',
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.step?.phase, 'committed');
  assert.equal(resolved.runStatus, 'resumable');
});

test('parked run survives SQLite reopen in waiting_park and wakes via delivered signal on scheduler tick [AC:durable-saga-park-reconcile#AC-3]', async (t) => {
  const { repoRoot, stateDir } = makeTempDirs(t, 'p3-park-wake-');

  const rt1 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'noop',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'unused' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
  });
  rt1.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const session = rt1.createChatSession({ title: 'parked-job', message: 'wait for webhook', background: false });
  const run = rt1.store.durableJournal.beginRun({ runId: 'drun_park_core', sessionId: session.id });
  rt1.store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'tc_wait', name: 'async_probe', input: {} },
  ]);
  const sPark = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    fencingEpoch: 1,
    kind: 'tool_call',
    toolCallId: 'tc_wait',
    toolName: 'async_probe',
    idempotencyKey: 'ik_wait',
    effectClass: 'read',
    replayPolicy: 'safe',
  });
  rt1.store.durableJournal.memo(sPark.stepId, 'job_token', 'tok_abc_123');
  rt1.store.durableJournal.parkStep(sPark.stepId, {
    kind: 'park',
    signals: [{ name: 'ci_done', key: 'build-9' }],
    checkpoint: { buildId: 'build-9' },
  });
  rt1.store.durableJournal.updateRun(run.runId, { status: 'waiting_park' });
  await rt1.destroy();

  // Process 2 boots: waiting_park stays parked with 0 model calls!
  let modelCalls = 0;
  let observedMemo = '';
  const rt2 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'wake-model',
      async runTurn() {
        modelCalls += 1;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'CI finished!' }] };
      },
      async summarizeMessages() {
        return '';
      },
    },
    extraTools: [
      {
        name: 'async_probe',
        description: 'resumed async tool',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        effectClass: 'read',
        replay: 'safe',
        execute: async (ctx) => {
          observedMemo = await ctx.memo('job_token', () => 'should-not-overwrite');
          return { ok: true, content: `resumed with ${observedMemo}` };
        },
      },
    ],
  });
  t.after(() => rt2.destroy());

  assert.equal(rt2.store.durableJournal.getRun(run.runId)?.status, 'waiting_park');
  await rt2.runScheduler();
  assert.equal(modelCalls, 0); // Still waiting for signal!

  // Deliver signal and tick scheduler -> wakes and completes!
  rt2.store.durableJournal.deliverSignal({
    runId: run.runId,
    stepId: sPark.stepId,
    signalName: 'ci_done',
    signalKey: 'build-9',
    payload: { passed: true },
  });
  await rt2.runScheduler();

  assert.equal(observedMemo, 'tok_abc_123');
  assert.equal(modelCalls, 1);
  assert.equal(rt2.getSession(session.id)?.status, 'idle');
  assert.equal(rt2.store.durableJournal.getRun(run.runId)?.status, 'completed');
});

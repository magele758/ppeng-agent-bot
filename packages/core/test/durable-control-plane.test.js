/**
 * Phase 1 Core + Daemon integration tests for the Durable Control Plane.
 * Exercises real RawAgentRuntime + SQLite reopen + scheduler auto-resume +
 * hot-switched durable_settings KV + prompt-cache invariance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RawAgentRuntime,
  readDurableSettings,
  writeDurableSettings,
} from '../dist/exports/public.js';
import { recoverInterruptedSessions } from '../dist/runtime/restart-recovery.js';

function createTempDirs(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const repoRoot = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, repoRoot, stateDir };
}

function scriptedAdapter(handler) {
  let calls = 0;
  return {
    name: 'durable-core-test-model',
    get calls() {
      return calls;
    },
    async runTurn(input) {
      calls += 1;
      return handler(input, calls);
    },
    async summarizeMessages() {
      return 'summary';
    },
  };
}

test('real RawAgentRuntime commits tools atomically and auto-resumes crashed ordinary chat via scheduler tick [AC:durable-agent-control-plane#AC-1] [AC:durable-agent-control-plane#AC-5]', async (t) => {
  const { repoRoot, stateDir } = createTempDirs(t, 'durable-core-resume-');

  // Process 1: create chat session, seed mid-wave crash state (tool_a committed, tool_b safe unknown)
  let countA1 = 0;
  let countB1 = 0;
  const rt1 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: scriptedAdapter(async () => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'unused' }],
    })),
    extraTools: [
      {
        name: 'probe_write',
        description: 'probe write tool',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'workspace',
        effectClass: 'workspace_fs',
        replay: 'unsafe',
        execute: async () => {
          countA1 += 1;
          return { ok: true, content: 'wrote-once' };
        },
      },
      {
        name: 'probe_read',
        description: 'probe safe read tool',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        effectClass: 'read',
        replay: 'safe',
        execute: async () => {
          countB1 += 1;
          return { ok: true, content: 'read-fresh' };
        },
      },
    ],
  });
  rt1.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const session = rt1.createChatSession({ title: 'crash-resume', message: 'write then read', background: false });
  const run = rt1.store.durableJournal.beginRun({ runId: 'drun_crash_1', sessionId: session.id });
  rt1.store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'tc_a', name: 'probe_write', input: {} },
    { type: 'tool_call', toolCallId: 'tc_b', name: 'probe_read', input: {} },
  ]);
  rt1.store.appendMessage(session.id, 'tool', [
    { type: 'tool_result', toolCallId: 'tc_a', name: 'probe_write', ok: true, content: 'wrote-once' },
  ]);
  const sA = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    fencingEpoch: 1,
    kind: 'tool_call',
    toolCallId: 'tc_a',
    toolName: 'probe_write',
    idempotencyKey: 'ik_a',
    effectClass: 'workspace_fs',
    replayPolicy: 'unsafe',
  });
  rt1.store.durableJournal.markStepDispatched(sA.stepId);
  rt1.store.durableJournal.commitStep(sA.stepId);
  const sB = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    fencingEpoch: 1,
    kind: 'tool_call',
    toolCallId: 'tc_b',
    toolName: 'probe_read',
    idempotencyKey: 'ik_b',
    effectClass: 'read',
    replayPolicy: 'safe',
  });
  rt1.store.durableJournal.markStepDispatched(sB.stepId);
  rt1.store.updateSession(session.id, { status: 'running' });
  await rt1.destroy();

  // Process 2: boot RawAgentRuntime (synchronous boot recovery — no LLM/tool work yet!)
  let countA2 = 0;
  let countB2 = 0;
  const adapter2 = scriptedAdapter(async (input) => {
    const toolResults = input.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
    assert.equal(toolResults.length, 2);
    return {
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'auto-resumed answer' }],
    };
  });
  const rt2 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: adapter2,
    extraTools: [
      {
        name: 'probe_write',
        description: 'probe write tool',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'workspace',
        effectClass: 'workspace_fs',
        replay: 'unsafe',
        execute: async () => {
          countA2 += 1;
          return { ok: true, content: 'should-never-replay' };
        },
      },
      {
        name: 'probe_read',
        description: 'probe safe read tool',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'none',
        effectClass: 'read',
        replay: 'safe',
        execute: async () => {
          countB2 += 1;
          return { ok: true, content: 'read-after-restart' };
        },
      },
    ],
  });
  t.after(() => rt2.destroy());

  // Immediately after boot: zero LLM/tool work; durable run is marked resumable; safe tc_b stayed open
  assert.equal(adapter2.calls, 0);
  assert.equal(countA2, 0);
  assert.equal(countB2, 0);
  const afterBootRun = rt2.store.durableJournal.getRun(run.runId);
  assert.equal(afterBootRun?.status, 'resumable');
  assert.equal(afterBootRun?.restarts, 1);
  assert.equal(rt2.store.durableJournal.getStep(sB.stepId)?.phase, 'unknown');

  // Now run one scheduler tick -> auto-resumes crashed ordinary chat automatically!
  await rt2.runScheduler();

  assert.equal(countA1, 0);
  assert.equal(countB1, 0);
  assert.equal(countA2, 0); // Committed unsafe write NEVER re-executed!
  assert.equal(countB2, 1); // Safe read replayed once on resume!
  assert.equal(adapter2.calls, 1);
  assert.equal(rt2.getSession(session.id)?.status, 'idle');
  assert.equal(rt2.store.durableJournal.getRun(run.runId)?.status, 'completed');
});

test('boot recovery closes interrupted unsafe tools and never replays them on auto-resume [AC:durable-agent-control-plane#AC-2]', async (t) => {
  const { repoRoot, stateDir } = createTempDirs(t, 'durable-core-unsafe-');

  const rt1 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: scriptedAdapter(async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'noop' }] })),
  });
  rt1.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  const session = rt1.createChatSession({ title: 'unsafe-crash', message: 'do unsafe op', background: false });
  const run = rt1.store.durableJournal.beginRun({ runId: 'drun_unsafe_core', sessionId: session.id });
  rt1.store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'tc_unsafe', name: 'unsafe_op', input: {} },
  ]);
  const sU = rt1.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    fencingEpoch: 1,
    kind: 'tool_call',
    toolCallId: 'tc_unsafe',
    toolName: 'unsafe_op',
    idempotencyKey: 'ik_u',
    effectClass: 'workspace_fs',
    replayPolicy: 'unsafe',
  });
  rt1.store.durableJournal.markStepDispatched(sU.stepId);
  rt1.store.updateSession(session.id, { status: 'running' });
  await rt1.destroy();

  let unsafeCalls = 0;
  const rt2 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: scriptedAdapter(async (input) => {
      const tr = input.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool_result');
      assert.equal(tr?.ok, false);
      assert.match(tr?.content ?? '', /interrupted/i);
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'inspected after interrupt' }] };
    }),
    extraTools: [
      {
        name: 'unsafe_op',
        description: 'unsafe op',
        inputSchema: { type: 'object' },
        approvalMode: 'never',
        sideEffectLevel: 'workspace',
        effectClass: 'workspace_fs',
        replay: 'unsafe',
        execute: async () => {
          unsafeCalls += 1;
          return { ok: true, content: 'duplicated!' };
        },
      },
    ],
  });
  t.after(() => rt2.destroy());

  await rt2.runScheduler();
  assert.equal(unsafeCalls, 0);
  assert.equal(rt2.getSession(session.id)?.status, 'idle');
});

test('hot-switching durable_settings.mode=off takes effect immediately with zero restart and keeps prompt cache identical [AC:durable-agent-control-plane#AC-5] [AC:durable-agent-control-plane#AC-6]', async (t) => {
  const { repoRoot, stateDir } = createTempDirs(t, 'durable-core-hotswitch-');

  const captured = [];
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: scriptedAdapter(async (input) => {
      captured.push({
        systemPrompt: input.systemPrompt,
        tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      });
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    }),
  });
  t.after(() => rt.destroy());

  // Default mode is atomic_workspace, chatRestartPolicy is auto_resume
  assert.equal(readDurableSettings(rt.store).mode, 'atomic_workspace');
  assert.equal(readDurableSettings(rt.store).chatRestartPolicy, 'auto_resume');

  const sOn = rt.createChatSession({ title: 'durable-on', message: 'hello', background: false });
  await rt.runSession(sOn.id);
  assert.equal(rt.store.durableJournal.listRunsForSession(sOn.id).length, 1);

  // Hot-switch to off without restarting RawAgentRuntime
  writeDurableSettings(rt.store, { mode: 'off' });
  assert.equal(readDurableSettings(rt.store).mode, 'off');

  const sOff = rt.createChatSession({ title: 'durable-off', message: 'hello', background: false });
  await rt.runSession(sOff.id);
  assert.equal(rt.store.durableJournal.listRunsForSession(sOff.id).length, 0);

  // Prompt Cache invariance: exact same systemPrompt and tool schema with durable on vs off
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[0], captured[1]);

  // Verify boot recovery under mode=off settles running durable runs to failed (legacy_fail behavior)
  const s3 = rt.createChatSession({ title: 'legacy-crash', message: 'hi', background: false });
  const r3 = rt.store.durableJournal.beginRun({ runId: 'drun_legacy_off', sessionId: s3.id });
  rt.store.updateSession(s3.id, { status: 'running' });
  recoverInterruptedSessions(rt.store);
  assert.equal(rt.store.durableJournal.getRun(r3.runId)?.status, 'failed');
});

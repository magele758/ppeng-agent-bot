import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySurfaceStore } from '../../agent-loop/dist/session/surface-store.js';
import { noteTrajectoryWrite, runSessionKernel } from '@ppeng/agent-loop';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';

function toolCall(id, name, input) {
  return { type: 'tool_call', toolCallId: id, name, input };
}

function textTurn(text) {
  return { stopReason: 'end', assistantParts: [{ type: 'text', text }] };
}

function toolTurn(parts) {
  return { stopReason: 'tool_use', assistantParts: parts };
}

function openRun(caps, script, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-round-'));
  const stateDir = join(dir, 'state');
  const repoRoot = join(dir, 'repo');
  mkdirSync(stateDir);
  mkdirSync(repoRoot);
  const surface = createMemorySurfaceStore();
  const spec = { id: 'agent-1', name: 'Test', role: 'assistant', instructions: 'test', capabilities: [] };
  const session = surface.createSession({ title: 'handoff', mode: 'chat', agentId: spec.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'ship the change' }]);
  surface.updateSession(session.id, {
    metadata: {
      capabilityTiers: {
        enabled: true,
        enablementSource: 'explicit_on',
        caps,
      },
    },
  });
  const names = new Set([
    'submit_plan',
    'request_confirmation',
    'confirm_plan',
    'start_step',
    'complete_step',
    'fail_step',
    'write_file',
  ]);
  const tools = createBuiltinTools({}).filter((tool) => names.has(tool.name));
  const plannerSeen = [];
  const executorSeen = [];
  const seenMeta = [];
  const queue = [...script];
  const adapter = (bucket) => ({
    name: bucket === plannerSeen ? 'planner-model' : 'executor-model',
    async runTurn(input) {
      bucket.push(JSON.stringify(input.messages ?? input));
      const next = queue.shift();
      return next ? next() : textTurn('done');
    },
    async summarizeMessages() {
      return '';
    },
  });
  const planner = adapter(plannerSeen);
  const executor = adapter(executorSeen);
  const store = {
    getSession: (id) => surface.getSession(id),
    updateSession: (id, patch) => surface.updateSession(id, patch),
    foldMessages: (id) => surface.foldMessages(id),
    appendMessage: (id, role, parts, opts) => surface.appendMessage(id, role, parts, opts),
    appendReplacement: (id, input) => surface.appendReplacement(id, input),
    getAgent: (id) => (id === spec.id ? spec : undefined),
    claimWriter: (id, runId) => surface.claimWriter(id, runId),
    releaseWriter: (id, runId) => surface.releaseWriter(id, runId),
    listApprovals: () => [],
    claimInbox: (id, target) => surface.claimInbox(id, target),
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, opts) => surface.hideRange(id, start, end, opts),
    getDaemonControl: () => undefined,
  };
  const host = {
    store,
    repoRoot,
    stateDir,
    modelAdapter: planner,
    promptBuilder: { buildSystemPrompt: async () => 'sys', buildMemoryAppendix: () => '' },
    tools,
    maxTurnsPerRun: 8,
    emitTrace: () => undefined,
    mergeSessionMetadata: (id, patch) => {
      const current = store.getSession(id);
      return store.updateSession(id, { metadata: { ...current.metadata, ...patch } });
    },
    runTurnWithRetries: (input) => {
      const live = store.getSession(session.id);
      seenMeta.push(live?.metadata);
      return live?.metadata?.handoffRole === 'executor' ? executor.runTurn(input) : planner.runTurn(input);
    },
    executeToolCalls: async (toolCalls, context) => {
      const results = [];
      for (const item of toolCalls) {
        const tool = tools.find((entry) => entry.name === item.name);
        if (!tool) throw new Error(`missing tool ${item.name}`);
        const result = await tool.execute(context, item.input);
        if (!result.ok) throw new Error(`${item.name}: ${result.content}`);
        if (item.name === 'fail_step' && options.stickWrite) noteTrajectoryWrite(session.id, 'stuck-write');
        results.push({
          toolCallId: item.toolCallId,
          name: item.name,
          ok: result.ok,
          content: result.content,
          metadata: result.metadata,
        });
      }
      return results;
    },
    prepareMessagesForModel: async (_session, messages) => messages,
    autoCompact: async () => ({}),
    handleTurnCompletion: async (current) => store.updateSession(current.id, { status: 'idle' }),
    processToolResults: (results, _calls, _session, _task, sessionId) => {
      store.appendMessage(sessionId, 'tool', results.map((result) => ({
        type: 'tool_result',
        toolCallId: result.toolCallId,
        name: result.name,
        ok: result.ok,
        content: result.content,
      })));
    },
  };
  return {
    dir,
    repoRoot,
    host,
    store,
    session,
    plannerSeen,
    executorSeen,
    seenMeta,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function submitWave() {
  return toolTurn([
    toolCall('submit-1', 'submit_plan', {
      analysis: 'ship it',
      steps: ['step-a', 'step-b'],
      expected_old_version: 0,
    }),
    toolCall('write-1', 'write_file', { path: 'secret.txt', content: 'nope' }),
  ]);
}

function workWave(startVersion) {
  return toolTurn([
    toolCall('confirm-1', 'request_confirmation', { expected_old_version: startVersion }),
    toolCall('start-a', 'start_step', {
      step_index: 1,
      dedupe_id: 'dedupe-a',
      attempt_id: 'attempt-a',
      expected_old_version: startVersion + 1,
    }),
    toolCall('complete-a', 'complete_step', {
      step_index: 1,
      result: 'step a landed',
      expected_old_version: startVersion + 2,
    }),
    toolCall('start-b', 'start_step', {
      step_index: 2,
      dedupe_id: 'dedupe-b',
      attempt_id: 'attempt-b',
      expected_old_version: startVersion + 3,
    }),
    toolCall('fail-b', 'fail_step', {
      step_index: 2,
      error: 'disk full',
      expected_old_version: startVersion + 4,
    }),
  ]);
}

test('real plan tools publish, repair, and show the executor the revised plan', async () => {
  const run = openRun({ perTurn: 4, perSession: 6 }, [
    submitWave,
    () => workWave(1),
    () => toolTurn([
      toolCall('repair-1', 'submit_plan', {
        analysis: 'retry the failed step',
        steps: ['step-a', 'step-b-retry'],
        expected_old_version: 6,
      }),
    ]),
    () => textTurn('executor saw the revision'),
  ]);
  try {
    await runSessionKernel(run.host, run.session.id);
    const metadata = run.store.getSession(run.session.id).metadata;
    assert.equal(existsSync(join(run.repoRoot, 'secret.txt')), false);
    assert.equal(metadata.handoffRole, 'executor');
    assert.equal(metadata.handoffState, 'executor_write');
    assert.equal(metadata.handoffSessionCount, 3);
    const planner = run.plannerSeen.join('\n');
    const executor = run.executorSeen.join('\n');
    assert.match(planner, /disk full/);
    assert.match(planner, /dedupe-a/);
    assert.match(planner, /\\"version\\":6/);
    assert.match(executor, /\\"version\\":7/);
    assert.match(executor, /disk full/);
    assert.match(executor, /dedupe-a/);
    assert.match(executor, /\[failed\] step-b/);
    assert.equal(run.plannerSeen.length >= 2, true, planner);
    assert.equal(run.executorSeen.length >= 2, true, executor);
  } finally {
    run.close();
  }
});

test('a turn cap blocks repair and the next user turn reopens the planner', async () => {
  const run = openRun({ perTurn: 1, perSession: 6 }, [
    submitWave,
    () => toolTurn([
      toolCall('confirm-1', 'request_confirmation', { expected_old_version: 1 }),
      toolCall('start-b', 'start_step', {
        step_index: 2,
        dedupe_id: 'dedupe-b',
        attempt_id: 'attempt-b',
        expected_old_version: 2,
      }),
      toolCall('fail-b', 'fail_step', {
        step_index: 2,
        error: 'disk full',
        expected_old_version: 3,
      }),
    ]),
    () => textTurn('capped'),
    () => textTurn('reopened'),
  ]);
  try {
    await runSessionKernel(run.host, run.session.id);
    const capped = run.store.getSession(run.session.id).metadata;
    assert.equal(capped.handoffState, 'capped');
    assert.equal(capped.handoffCapReason, 'turn_cap');
    assert.notEqual(capped.handoffState, 'planner_repair');
    assert.equal(capped.handoffSessionCount, 1);
    await runSessionKernel(run.host, run.session.id);
    const reopened = run.seenMeta.at(-1);
    assert.equal(reopened.handoffSuspended, undefined);
    assert.equal(reopened.handoffState, 'planner_readonly');
    assert.equal(reopened.handoffRole, 'planner');
    assert.equal(reopened.handoffKernel.counters.sessionHandoffs, 1);
    assert.equal(reopened.handoffKernel.counters.turnHandoffs, 0);
    assert.match(run.plannerSeen.at(-1), /ship the change/);
  } finally {
    run.close();
  }
});

test('session exhaustion suspends the next user turn and later tools leave the gate', async () => {
  const run = openRun({ perTurn: 4, perSession: 1 }, [
    submitWave,
    () => toolTurn([
      toolCall('confirm-1', 'request_confirmation', { expected_old_version: 1 }),
      toolCall('start-b', 'start_step', {
        step_index: 2,
        dedupe_id: 'dedupe-b',
        attempt_id: 'attempt-b',
        expected_old_version: 2,
      }),
      toolCall('fail-b', 'fail_step', {
        step_index: 2,
        error: 'disk full',
        expected_old_version: 3,
      }),
    ]),
    () => textTurn('exhausted'),
    () => toolTurn([
      toolCall('write-2', 'write_file', { path: 'after-cap.txt', content: 'ungated' }),
    ]),
    () => textTurn('wrote'),
  ]);
  try {
    await runSessionKernel(run.host, run.session.id);
    const capped = run.store.getSession(run.session.id).metadata;
    assert.equal(capped.handoffCapReason, 'session_cap');
    assert.equal(capped.handoffSuspended, undefined);
    await runSessionKernel(run.host, run.session.id);
    const suspended = run.store.getSession(run.session.id).metadata;
    assert.equal(suspended.handoffSuspended, 'session_cap');
    assert.equal(existsSync(join(run.repoRoot, 'after-cap.txt')), true);
    assert.equal(suspended.capabilityTiers.enablementSource, 'explicit_on');
  } finally {
    run.close();
  }
});

test('a real failed step does not repair while one of its writes is still open', async () => {
  const run = openRun({ perTurn: 4, perSession: 6 }, [
    submitWave,
    () => workWave(1),
    () => textTurn('blocked'),
  ], { stickWrite: true });
  try {
    await runSessionKernel(run.host, run.session.id);
    const metadata = run.store.getSession(run.session.id).metadata;
    assert.equal(metadata.handoffState, 'executor_write');
    assert.equal(metadata.handoffBlocked, 'pending_writes');
    assert.notEqual(metadata.handoffState, 'planner_repair');
  } finally {
    run.close();
  }
});

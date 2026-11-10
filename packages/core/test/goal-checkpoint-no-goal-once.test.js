import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

const NO_GOAL = 'No goal is assigned to this execution';

function toolResults(runtime, sessionId) {
  return runtime.store.foldMessages(sessionId).flatMap((message) => message.parts).filter((part) => part.type === 'tool_result');
}

function goalRows(runtime) {
  return runtime.store.db.prepare("SELECT key FROM daemon_control WHERE key LIKE 'bot_goals:%'").all();
}

function openRuntime(t, modelAdapter, extraTools = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'goal-checkpoint-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'goal-checkpoint-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    extraTools,
    modelAdapter: {
      name: 'goal-checkpoint-script',
      summarizeMessages: async () => '',
      completeText: async () => JSON.stringify({ met: false, reason: 'no goal' }),
      ...modelAdapter
    }
  });
  t.after(async () => {
    await runtime.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  return runtime;
}

test('unassigned goal_checkpoint returns the clear error once and creates no goal [AC:goal-checkpoint-no-goal-once#AC-1] [AC:goal-checkpoint-no-goal-once#AC-2]', async (t) => {
  let turns = 0;
  const runtime = openRuntime(t, {
    async runTurn() {
      turns += 1;
      return {
        stopReason: 'tool',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: `goal-${turns}`,
          name: 'goal_checkpoint',
          input: { kind: 'progress', summary: 'nothing assigned' }
        }]
      };
    }
  });
  const session = runtime.createChatSession({
    title: 'no goal',
    message: 'save progress',
    agentId: 'general',
    metadata: { maxTurns: 24 }
  });
  await runtime.runSession(session.id);
  const checkpoints = toolResults(runtime, session.id).filter((part) => part.name === 'goal_checkpoint');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].ok, false);
  assert.equal(checkpoints[0].content, NO_GOAL);
  assert.equal(turns, 1);
  assert.equal(runtime.getSession(session.id).metadata.botGoalId, undefined);
  assert.deepEqual(goalRows(runtime), []);
});

test('a source-scope denial stays a denial [AC:goal-checkpoint-no-goal-once#AC-3]', async (t) => {
  let probes = 0;
  let calls = 0;
  const runtime = openRuntime(t, {
    async runTurn() {
      calls += 1;
      return {
        stopReason: 'tool',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: `probe-${calls}`,
          name: 'scope_probe',
          input: {}
        }]
      };
    }
  }, [{
    name: 'scope_probe',
    description: 'Probe that must stay denied when the source scope refuses it.',
    inputSchema: { type: 'object', properties: { nonce: { type: 'number' } } },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    async execute() {
      probes += 1;
      return { ok: true, content: 'probe ran' };
    }
  }]);
  runtime.store.setDaemonControl('tool_exposure_settings', {
    mode: 'full',
    searchStrategy: 'legacy',
    pinnedGroups: {}
  });
  const session = runtime.createChatSession({
    title: 'denied effect',
    message: '«external source=mail label=note»\nrun the probe',
    agentId: 'general',
    metadata: { maxTurns: 24, permissionMode: 'auto' }
  });
  const current = runtime.getSession(session.id);
  runtime.store.updateSession(session.id, {
    metadata: { ...current.metadata, approvalWake: { kind: 'unattended', source: 'cron' } }
  });
  await runtime.runSession(session.id);
  const probesResults = toolResults(runtime, session.id).filter((part) => part.name === 'scope_probe');
  assert.ok(probesResults.length >= 1);
  assert.equal(probes, 0);
  for (const part of probesResults) {
    assert.equal(part.ok, false);
    assert.match(part.content, /source_scope_denied/);
    assert.notEqual(part.content, NO_GOAL);
  }
  assert.equal(toolResults(runtime, session.id).some((part) => part.content === NO_GOAL), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { BotGoalService } from '../dist/bots/goals/service.js';

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

test('a resumed unassigned goal_checkpoint is saved once and creates no goal [AC:goal-checkpoint-no-goal-once#AC-4]', async (t) => {
  for (const kernelVariant of ['agent-loop', 'ppeng']) {
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
    runtime.store.setDaemonControl('loop_settings', { kernelVariant, engineEnabled: true });
    const session = runtime.createChatSession({
      title: 'resume no goal',
      message: 'save progress',
      agentId: 'general',
      metadata: { maxTurns: 24 }
    });
    runtime.store.appendMessage(session.id, 'assistant', [{
      type: 'tool_call',
      toolCallId: 'resume-goal',
      name: 'goal_checkpoint',
      input: { kind: 'progress', summary: 'nothing assigned' }
    }]);
    const current = runtime.getSession(session.id);
    runtime.store.updateSession(session.id, {
      status: 'idle',
      metadata: {
        ...current.metadata,
        interrupt: {
          kind: 'waiting_approval',
          toolCallIds: ['resume-goal'],
          approvalIds: [],
          executedToolCallIds: [],
          stepCursor: 'tools'
        }
      }
    });
    await runtime.runSession(session.id);
    const checkpoints = toolResults(runtime, session.id).filter((part) => part.name === 'goal_checkpoint');
    assert.equal(checkpoints.length, 1, kernelVariant);
    assert.equal(checkpoints[0].toolCallId, 'resume-goal', kernelVariant);
    assert.equal(checkpoints[0].ok, false, kernelVariant);
    assert.equal(checkpoints[0].content, NO_GOAL, kernelVariant);
    assert.equal(turns, 0, kernelVariant);
    assert.equal(runtime.getSession(session.id).metadata.botGoalId, undefined, kernelVariant);
    assert.deepEqual(goalRows(runtime), [], kernelVariant);
  }
});

async function assignRunningGoal(runtime, name) {
  const bot = runtime.createBot({ name });
  const sid = runtime.openBot(bot.id).sessionId;
  const service = new BotGoalService(runtime.store, Date.now, sid);
  const goal = service.create({ botId: bot.id, sessionId: sid, title: name, objective: 'Verify result' });
  const execution = service.claim(bot.id, goal.id, { strategy: 'direct' });
  service.updateExecution(bot.id, execution.id, { sessionId: sid });
  const current = runtime.getSession(sid);
  runtime.store.updateSession(sid, {
    metadata: {
      ...current.metadata,
      botGoalId: goal.id,
      botGoalExecutionId: execution.id,
      maxTurns: 24
    }
  });
  runtime.store.appendMessage(sid, 'user', [{ type: 'text', text: 'save progress' }]);
  return { sid, goal };
}

function checkpointModel(input) {
  let turns = 0;
  return {
    turns: () => turns,
    async runTurn() {
      turns += 1;
      return {
        stopReason: 'tool',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: `goal-${turns}`,
          name: 'goal_checkpoint',
          input
        }]
      };
    }
  };
}

test('invalid checkpoint kind and unauthorized waiting each fail once with their own text [AC:goal-checkpoint-no-goal-once#AC-5]', async (t) => {
  for (const kernelVariant of ['agent-loop', 'ppeng']) {
  const invalidModel = checkpointModel({ kind: 'nope', summary: 'bad kind' });
  const invalidRuntime = openRuntime(t, invalidModel);
  invalidRuntime.store.setDaemonControl('loop_settings', { kernelVariant, engineEnabled: true });
  const invalid = await assignRunningGoal(invalidRuntime, 'Invalid kind');
  await invalidRuntime.runSession(invalid.sid);
  const invalidResults = toolResults(invalidRuntime, invalid.sid).filter((part) => part.name === 'goal_checkpoint');
  assert.equal(invalidResults.length, 1);
  assert.equal(invalidResults[0].ok, false);
  assert.equal(invalidResults[0].content, 'Invalid checkpoint kind');
  assert.notEqual(invalidResults[0].content, NO_GOAL);
  assert.equal(invalidModel.turns(), 1);
  assert.equal(invalidRuntime.getSession(invalid.sid).metadata.botGoalCheckpoint, undefined);
  assert.notEqual(invalidRuntime.getSession(invalid.sid).metadata.outcome?.reason, 'goal_checkpoint_unassigned');
  assert.equal(invalidRuntime.getSession(invalid.sid).metadata.outcome?.reason, 'goal_checkpoint_invalid_kind');

  const waitingModel = checkpointModel({
    kind: 'waiting',
    summary: 'untrusted',
    wait: { source: 'session', correlationId: 'foreign' }
  });
  const waitingRuntime = openRuntime(t, waitingModel);
  waitingRuntime.store.setDaemonControl('loop_settings', { kernelVariant, engineEnabled: true });
  const waiting = await assignRunningGoal(waitingRuntime, 'Unauthorized wait');
  await waitingRuntime.runSession(waiting.sid);
  const waitingResults = toolResults(waitingRuntime, waiting.sid).filter((part) => part.name === 'goal_checkpoint');
  assert.equal(waitingResults.length, 1);
  assert.equal(waitingResults[0].ok, false);
  assert.equal(waitingResults[0].content, 'Waiting requires an execution reference authorized by goal_dispatch');
  assert.notEqual(waitingResults[0].content, NO_GOAL);
  assert.equal(waitingModel.turns(), 1);
  assert.equal(waitingRuntime.getSession(waiting.sid).metadata.botGoalCheckpoint, undefined);
  assert.notEqual(waitingRuntime.getSession(waiting.sid).metadata.outcome?.reason, 'goal_checkpoint_unassigned');
  assert.equal(waitingRuntime.getSession(waiting.sid).metadata.outcome?.reason, 'goal_checkpoint_wait_unauthorized', kernelVariant);
  }
});

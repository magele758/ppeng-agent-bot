import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { CHECKPOINTS_METADATA_KEY, saveStepCheckpoint } from '../dist/session/checkpoint.js';
import { DurableWaitStore } from '../dist/waits/index.js';

const READERS = ['read_file', 'grep_files', 'list_files', 'history_read', 'history_search', 'memory_get'];

function fixture(t, effects) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-restart-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const parent = store.createSession({ title: 'Bot', mode: 'chat', agentId: 'general', metadata: { canonicalBotChat: true, botId: 'b', permissionMode: 'ask', allowedTools: ['read_file', 'spawn_subagent'], userId: 'owner' } });
  const service = new BotGoalService(store, Date.now, parent.id);
  const runs = [];
  const running = new Set();
  const host = {
    store,
    isRunning: id => running.has(id),
    cancel() {},
    run(id) { runs.push(id); running.add(id); return new Promise(() => {}); },
    capabilities: () => ({ registeredTools: ['spawn_subagent', 'read_file'], enabledStrategies: ['direct', 'subagent'] }),
    executionInterrupted(id) {
      const session = store.getSession(id);
      return !session || (!running.has(id) && !store.isSessionWriterLive(id) && (session.status === 'running' || session.status === 'unknown'));
    }
  };
  if (effects) host.hasUnconfirmedEffects = effects;
  return { store, parent, service, host, runs, running };
}

function toolCallIds(store, sessionId) {
  return store.foldMessages(sessionId).flatMap(message => message.parts.filter(part => part.type === 'tool_call').map(part => part.toolCallId));
}

function closedTool(store, sessionId, name, id) {
  store.appendMessage(sessionId, 'assistant', [{ type: 'tool_call', toolCallId: id, name, input: { path: 'notes.txt' } }]);
  store.appendMessage(sessionId, 'tool', [{ type: 'tool_result', toolCallId: id, name, content: 'noted', ok: true }]);
}

function executionSession(store, parent, goal) {
  return store.createSession({
    title: goal.title,
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id,
    metadata: { userId: parent.metadata.userId, botId: 'b', botGoalId: goal.id, botGoalScopeSessionId: parent.id }
  });
}

function retainCheckpoint(store, sessionId) {
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'do the goal' }]);
  closedTool(store, sessionId, 'bash', 'bash-before');
  const saved = saveStepCheckpoint(store, sessionId, { label: 'safe' });
  assert.equal(saved.ok, true, 'closed checkpoint');
  return saved.checkpoint;
}

function readerTail(store, sessionId) {
  for (const name of READERS) closedTool(store, sessionId, name, `tail-${name}`);
}

function releaseDeadWriter(store, sessionId) {
  const current = store.getSession(sessionId);
  store.updateSession(sessionId, { status: 'running', metadata: current.metadata });
  store.claimWriter(sessionId, 'run-before-restart');
  store.releaseWriter(sessionId, 'run-before-restart');
  assert.equal(store.isSessionWriterLive(sessionId), false);
}

function claimExecution(service, goal, sessionId) {
  const execution = service.claim('b', goal.id, { strategy: 'direct', leaseMs: 300000 });
  service.updateExecution('b', execution.id, { sessionId });
  assert.equal(execution.safeToRetry, false);
  assert.ok(execution.leaseUntil > Date.now());
  return execution;
}

function continuations(store) {
  return store.listSessions().filter(session => session.metadata.spawnSource === 'bot-goal-continuation');
}

function continuationText(store, sessionId) {
  return store.foldMessages(sessionId).flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n');
}

async function resumedGoal(t, tail) {
  const world = fixture(t, () => false);
  const goal = world.service.create({ botId: 'b', sessionId: world.parent.id, title: 'Fix notes', objective: 'Update the notes' });
  const session = executionSession(world.store, world.parent, goal);
  retainCheckpoint(world.store, session.id);
  if (tail === 'readers') readerTail(world.store, session.id);
  const before = toolCallIds(world.store, session.id);
  releaseDeadWriter(world.store, session.id);
  assert.equal(world.host.executionInterrupted(session.id), true);
  const execution = claimExecution(world.service, goal, session.id);
  await tickBotGoals(world.host);
  return { ...world, goal, session, before, execution };
}

test('a dead goal at a retained closed checkpoint continues once [AC:goal-restart-resume#AC-1]', async t => {
  for (const tail of ['none', 'readers']) {
    const world = await resumedGoal(t, tail);
    assert.equal(world.service.list('b').length, 1, tail);
    assert.equal(world.runs.length, 1, tail);
    assert.equal(continuations(world.store).length, 1, tail);
    const saved = world.service.get('b', world.goal.id);
    assert.equal(saved.id, world.goal.id, tail);
    assert.equal(saved.status, 'running', tail);
    assert.equal(saved.attempts, 2, tail);
    assert.match(saved.nextStep, /checkpoint/i, tail);
    assert.match(saved.nextStep, /unknown/i, tail);
    const oldExecution = world.service.executions('b', world.goal.id).find(item => item.id === world.execution.id);
    assert.equal(oldExecution.status, 'interrupted', tail);
    assert.equal(oldExecution.safeToRetry, false, tail);
    const started = world.service.executions('b', world.goal.id).find(item => item.status === 'running');
    assert.notEqual(started.id, world.execution.id, tail);
    assert.equal(started.sessionId, world.runs[0], tail);
    const text = continuationText(world.store, world.runs[0]);
    assert.match(text, /checkpoint/i, tail);
    assert.match(text, /unknown/i, tail);
    assert.deepEqual(toolCallIds(world.store, world.session.id), world.before, tail);
    assert.deepEqual(toolCallIds(world.store, world.runs[0]), [], tail);
    assert.equal(toolCallIds(world.store, world.session.id).filter(id => id === 'bash-before').length, 1, tail);
    await tickBotGoals(world.host);
    assert.equal(world.runs.length, 1, tail);
    assert.equal(continuations(world.store).length, 1, tail);
    assert.equal(world.service.get('b', world.goal.id).attempts, 2, tail);
    assert.deepEqual(toolCallIds(world.store, world.session.id), world.before, tail);
    assert.deepEqual(toolCallIds(world.store, world.runs[0]), [], tail);
  }
});

test('a live writer, a running session, or an approval hold is left alone [AC:goal-restart-resume#AC-2]', async t => {
  const cases = [
    { name: 'live writer', hold(world, sessionId) { world.store.claimWriter(sessionId, 'still-live'); assert.equal(world.store.isSessionWriterLive(sessionId), true); } },
    { name: 'process running', hold(world, sessionId) { world.running.add(sessionId); releaseDeadWriter(world.store, sessionId); } },
    { name: 'approval hold', hold(world, sessionId) {
      const current = world.store.getSession(sessionId);
      world.store.updateSession(sessionId, { status: 'waiting_approval', metadata: current.metadata });
      world.store.claimWriter(sessionId, 'approval-run');
      world.store.releaseWriter(sessionId, 'approval-run');
      world.store.createApproval({ sessionId, toolName: 'bash', reason: 'Approval required for bash', args: { command: 'echo held' } });
    } }
  ];
  for (const item of cases) {
    const world = fixture(t, () => false);
    const goal = world.service.create({ botId: 'b', sessionId: world.parent.id, title: item.name, objective: 'Keep going' });
    const session = executionSession(world.store, world.parent, goal);
    retainCheckpoint(world.store, session.id);
    readerTail(world.store, session.id);
    const current = world.store.getSession(session.id);
    world.store.updateSession(session.id, { status: 'running', metadata: current.metadata });
    const execution = claimExecution(world.service, goal, session.id);
    item.hold(world, session.id);
    await tickBotGoals(world.host);
    await tickBotGoals(world.host);
    const saved = world.service.get('b', goal.id);
    assert.equal(saved.status, 'running', item.name);
    assert.equal(saved.attempts, 1, item.name);
    assert.equal(world.service.executions('b', goal.id).find(row => row.id === execution.id).status, 'running', item.name);
    assert.equal(world.runs.length, 0, item.name);
    assert.equal(continuations(world.store).length, 0, item.name);
  }
});

test('an unsafe dead goal stays blocked and is not continued [AC:goal-restart-resume#AC-3]', async t => {
  const cases = [
    { name: 'missing checkpoint', effects: () => false, transcript(store, sessionId) {
      store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'do the goal' }]);
      closedTool(store, sessionId, 'bash', 'bash-before');
    } },
    { name: 'checkpoint not retained', effects: () => false, transcript(store, sessionId) {
      retainCheckpoint(store, sessionId);
      const current = store.getSession(sessionId);
      const broken = current.metadata[CHECKPOINTS_METADATA_KEY].map(item => ({ ...item, seq: 999999 }));
      store.updateSession(sessionId, { metadata: { ...current.metadata, [CHECKPOINTS_METADATA_KEY]: broken } });
    } },
    { name: 'open tool call', effects: () => false, transcript(store, sessionId) {
      retainCheckpoint(store, sessionId);
      store.appendMessage(sessionId, 'assistant', [{ type: 'tool_call', toolCallId: 'open-1', name: 'read_file', input: { path: 'notes.txt' } }]);
    } },
    { name: 'non-reader after checkpoint', effects: () => false, transcript(store, sessionId) {
      retainCheckpoint(store, sessionId);
      closedTool(store, sessionId, 'bash', 'bash-after');
    } },
    { name: 'unconfirmed external effect', effects: () => true, transcript(store, sessionId) {
      retainCheckpoint(store, sessionId);
      readerTail(store, sessionId);
    } },
    { name: 'effects callback missing', effects: undefined, transcript(store, sessionId) {
      retainCheckpoint(store, sessionId);
      readerTail(store, sessionId);
    } }
  ];
  for (const item of cases) {
    const world = fixture(t, item.effects);
    const goal = world.service.create({ botId: 'b', sessionId: world.parent.id, title: item.name, objective: 'Update the notes' });
    const session = executionSession(world.store, world.parent, goal);
    item.transcript(world.store, session.id);
    const before = toolCallIds(world.store, session.id);
    releaseDeadWriter(world.store, session.id);
    assert.equal(world.host.executionInterrupted(session.id), true, item.name);
    claimExecution(world.service, goal, session.id);
    await tickBotGoals(world.host);
    await tickBotGoals(world.host);
    const saved = world.service.get('b', goal.id);
    assert.equal(saved.status, 'blocked', item.name);
    assert.match(saved.blockedReason, /verify external effects before retry/i, item.name);
    assert.equal(world.runs.length, 0, item.name);
    assert.equal(continuations(world.store).length, 0, item.name);
    assert.deepEqual(toolCallIds(world.store, session.id), before, item.name);
    assert.match(continuationText(world.store, world.parent.id), /verify external effects before retry/i, item.name);
  }
});

test('a goal parked on a durable wait is not resumed [AC:goal-restart-resume#AC-4]', async t => {
  const world = fixture(t, () => false);
  const goal = world.service.create({ botId: 'b', sessionId: world.parent.id, title: 'Wait for child', objective: 'Wait until the child finishes' });
  const session = executionSession(world.store, world.parent, goal);
  retainCheckpoint(world.store, session.id);
  readerTail(world.store, session.id);
  releaseDeadWriter(world.store, session.id);
  const execution = claimExecution(world.service, goal, session.id);
  const observed = world.store.createSession({ title: 'watched', mode: 'subagent', agentId: 'general', parentSessionId: world.parent.id, metadata: { userId: 'owner', botId: 'b' } });
  world.store.updateSession(observed.id, { status: 'running' });
  const liveGoal = world.service.get('b', goal.id);
  const wait = new DurableWaitStore(world.store).register({
    kind: 'goal', id: liveGoal.id, revision: liveGoal.revision, executionId: execution.id, botId: 'b', sessionId: session.id, scopeSessionId: world.parent.id
  }, { source: 'session', ref: observed.id, condition: { op: 'in', field: 'status', values: ['completed', 'failed', 'cancelled', 'unknown'] } });
  const snap = world.store.getDaemonControl('bot_goals:b');
  const row = snap.goals.find(item => item.id === goal.id);
  row.status = 'waiting';
  row.wait = { source: 'durable_wait', correlationId: wait.id };
  world.store.setDaemonControl('bot_goals:b', snap);
  await tickBotGoals(world.host);
  await tickBotGoals(world.host);
  const saved = world.service.get('b', goal.id);
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.wait.source, 'durable_wait');
  assert.equal(saved.wait.correlationId, wait.id);
  assert.equal(new DurableWaitStore(world.store).get(wait.id).status, 'waiting');
  assert.equal(world.service.executions('b', goal.id).find(item => item.id === execution.id).status, 'running');
  assert.equal(world.runs.length, 0);
  assert.equal(continuations(world.store).length, 0);
});

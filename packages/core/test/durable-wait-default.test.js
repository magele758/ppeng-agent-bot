import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  DURABLE_WAIT_DEFAULT,
  DurableWaitStore,
  observableDispatchWait,
  outstandingRoutineChildId,
  parkGoalDurableWait,
  terminalObservableCondition,
} from '../dist/waits/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dwd-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

test('observableDispatchWait accepts only durable-backed sources [AC:durable-wait-default#AC-1]', () => {
  assert.deepEqual(observableDispatchWait({ source: 'session', correlationId: 'c1' }), {
    source: 'session',
    ref: 'c1',
  });
  assert.deepEqual(observableDispatchWait({ source: 'bot_task', correlationId: 't1' }), {
    source: 'bot_task',
    ref: 't1',
  });
  assert.equal(observableDispatchWait({ source: 'durable_wait', correlationId: 'w1' }), undefined);
  assert.equal(observableDispatchWait({ source: 'team_dag', correlationId: 'p1' }), undefined);
  assert.equal(observableDispatchWait(undefined), undefined);
});

test('sessions and Bot tasks wait for terminal status, routine runs also wait for a version change [AC:durable-wait-default#AC-1]', () => {
  assert.deepEqual(terminalObservableCondition('session'), {
    op: 'in',
    field: 'status',
    values: ['completed', 'failed', 'cancelled', 'unknown', 'expired', 'rejected', 'timed_out'],
  });
  assert.deepEqual(terminalObservableCondition('bot_task'), terminalObservableCondition('session'));
  const other = terminalObservableCondition('routine_run');
  assert.equal(other.op, 'all');
});

test('parkGoalDurableWait host-registers without wait_for receipt [AC:durable-wait-default#AC-2]', (t) => {
  const { store } = fixture(t);
  const scope = store.createSession({
    title: 'scope',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice', botId: 'b', canonicalBotChat: true },
  });
  const exec = store.createSession({
    title: 'exec',
    mode: 'chat',
    agentId: 'general',
    parentSessionId: scope.id,
    metadata: {
      userId: 'alice',
      botId: 'b',
      botGoalId: 'g1',
      botGoalScopeSessionId: scope.id,
      botGoalExecutionId: 'e1',
    },
  });
  const child = store.createSession({
    title: 'child',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: exec.id,
    metadata: { userId: 'alice', botId: 'b' },
  });
  const parked = parkGoalDurableWait(
    store,
    exec,
    { id: 'g1', revision: 1, botId: 'b' },
    'e1',
    { source: 'session', correlationId: child.id },
    'Child still running'
  );
  assert.ok(parked);
  assert.equal(parked.kind, 'waiting');
  assert.equal(parked.wait?.source, 'durable_wait');
  const wait = new DurableWaitStore(store).get(parked.wait.correlationId);
  assert.equal(wait?.hostRegistered, true);
  assert.equal(wait?.spec.source, 'session');
  assert.equal(wait?.spec.ref, child.id);
  assert.match(DURABLE_WAIT_DEFAULT, /default way to suspend/);
});

test('outstandingRoutineChildId returns non-terminal child [AC:durable-wait-default#AC-3]', (t) => {
  const { store } = fixture(t);
  const parent = store.createSession({
    title: 'routine',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice', botId: 'b' },
  });
  assert.equal(outstandingRoutineChildId(store, parent.id, 'run-1'), undefined);
  const unrelated = store.createSession({
    title: 'other',
    mode: 'chat',
    agentId: 'general',
    parentSessionId: parent.id,
    metadata: { userId: 'alice', botId: 'b' },
  });
  store.updateSession(unrelated.id, { status: 'running' });
  assert.equal(outstandingRoutineChildId(store, parent.id, 'run-1'), undefined);
  const child = store.createSession({
    title: 'child',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id,
    metadata: { userId: 'alice', botId: 'b', spawnSource: 'subagent' },
  });
  store.updateSession(child.id, { status: 'running' });
  assert.equal(outstandingRoutineChildId(store, parent.id, 'run-1'), child.id);
  store.updateSession(child.id, { status: 'completed' });
  assert.equal(outstandingRoutineChildId(store, parent.id, 'run-1'), undefined);
});

test('a terminal Bot task releases a host wait including a persisted legacy wait [AC:bot-task-terminal-wait#AC-1]', t => {
  const { store } = fixture(t);
  const session = store.createSession({ title: 'owner', agentId: 'general', mode: 'chat', metadata: { userId: 'alice', botId: 'b', canonicalBotChat: true, botGoalId: 'g1' } });
  const waits = new DurableWaitStore(store);
  store.db.prepare('INSERT INTO bot_work_tasks(id,principal,requester_bot,target_bot,input,created_at,status,attempt,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('child', JSON.stringify(['','alice']), 'b', 'r', 'review', 'v0', 'completed', 1, 'v1');
  const goal = { id: 'g1', revision: 1, botId: 'b' };
  const park = id => parkGoalDurableWait(store, session, goal, id, {source:'bot_task',correlationId:'child'}, 'Read result').wait.correlationId;
  const current = park('new');
  const old = waits.get(park('old'));
  const terminal = { op:'in',field:'status',values:['completed','failed','cancelled','unknown','expired','rejected','timed_out'] };
  const legacy = { op:'all',conditions:[terminal,{op:'changed',field:'version'}] };
  old.spec.condition = legacy;
  store.db.prepare('UPDATE agent_waits SET payload=? WHERE id=?').run(JSON.stringify(old), old.id);
  const explicit = waits.register({...old.owner,executionId:'explicit'}, {...old.spec});
  for (const id of [current,old.id]) {
    assert.equal(waits.check(id).status,'ready');
    assert.equal(waits.consume(id,()=>{}),true);
    assert.equal(waits.consume(id,()=>{}),false);
  }
  assert.equal(waits.check(explicit.id).status,'waiting');
});

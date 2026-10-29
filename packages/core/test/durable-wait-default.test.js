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

test('terminalObservableCondition is status-only for sessions [AC:durable-wait-default#AC-1]', () => {
  assert.deepEqual(terminalObservableCondition('session'), {
    op: 'in',
    field: 'status',
    values: ['completed', 'failed', 'cancelled', 'unknown', 'expired', 'rejected', 'timed_out'],
  });
  const other = terminalObservableCondition('bot_task');
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

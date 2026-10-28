import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { DurableWaitStore } from '../dist/waits/index.js';
import { parkBackgroundDurableWait, recordBackgroundWaitSource } from '../dist/waits/background-source.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { activeWaitOwner } from '../dist/waits/tool.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bgpark-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

test('parkBackgroundDurableWait host-registers background_job wait without wait_for', (t) => {
  const { store } = fixture(t);
  const parent = store.createSession({
    title: 'scope',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice', botId: 'b', canonicalBotChat: true },
  });
  const service = new BotGoalService(store, Date.now, parent.id);
  const goal = service.create({
    botId: 'b',
    sessionId: parent.id,
    title: 'Run job',
    objective: 'finish background work',
  });
  const ex = service.claim('b', goal.id, { strategy: 'direct' });
  service.updateExecution('b', ex.id, { sessionId: parent.id });
  store.updateSession(parent.id, {
    metadata: {
      ...store.getSession(parent.id).metadata,
      botGoalId: goal.id,
      botGoalExecutionId: ex.id,
      botGoalScopeSessionId: parent.id,
    },
  });
  const owner = activeWaitOwner(store, store.getSession(parent.id));
  assert.ok(owner, 'activeWaitOwner should resolve for claimed goal execution');
  assert.equal(owner.kind, 'goal');
  const job = store.createBackgroundJob({
    sessionId: parent.id,
    command: 'sleep 1',
    status: 'running',
  });
  const parked = parkBackgroundDurableWait(store, parent.id, job, 'wait for sleep');
  assert.ok(parked, 'host park should succeed under active Goal owner');
  assert.equal(parked.waitFor.source, 'background_job');
  assert.equal(parked.waitFor.ref, job.id);
  const wait = new DurableWaitStore(store).get(parked.waitId);
  assert.equal(wait?.hostRegistered, true);
  assert.equal(wait?.spec.source, 'background_job');
  assert.equal(store.getSession(parent.id).metadata.agentWaitId, parked.waitId);
  const again = recordBackgroundWaitSource(store, parent.id, job);
  assert.equal(again?.ref, job.id);
});

test('parkBackgroundDurableWait is a no-op without active Goal/Routine owner', (t) => {
  const { store } = fixture(t);
  const session = store.createSession({
    title: 'free',
    mode: 'chat',
    agentId: 'general',
    metadata: { userId: 'alice' },
  });
  const job = store.createBackgroundJob({
    sessionId: session.id,
    command: 'sleep 1',
    status: 'running',
  });
  assert.equal(parkBackgroundDurableWait(store, session.id, job), undefined);
});

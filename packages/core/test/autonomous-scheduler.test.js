import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { AutonomousScheduler } from '../dist/services/autonomous-scheduler.js';

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-sched-'));
  return new SqliteStateStore(join(dir, 'state.db'));
}

function backgroundTask(store, title) {
  return store.createSession({ title, mode: 'task', agentId: 'general', background: true });
}

test('a rejected autonomous run does not reject unhandled and clears running', async () => {
  const rejections = [];
  const onRejection = (reason) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  const store = openStore();
  const warnings = [];
  const calls = [];
  try {
    const idle = backgroundTask(store, 'idle-agent-gone');
    const running = backgroundTask(store, 'still-running');
    const done = backgroundTask(store, 'already-completed');
    for (const session of [idle, running, done]) store.enqueueSchedulerWake(session.id, 'wake');
    const scheduler = new AutonomousScheduler({
      store,
      log: {
        warn(message, fields) {
          warnings.push({ message, fields });
        }
      },
      async runSession(sessionId) {
        calls.push(sessionId);
        if (sessionId === running.id) store.updateSession(sessionId, { status: 'running' });
        if (sessionId === done.id) store.updateSession(sessionId, { status: 'completed' });
        throw new Error(`Agent not found: ${sessionId}`);
      }
    });
    await scheduler.tick();
    await scheduler.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
    assert.equal(store.getSession(idle.id).status, 'failed');
    assert.equal(store.getSession(running.id).status, 'failed');
    assert.equal(store.getSession(done.id).status, 'completed');
    assert.equal(warnings.length, 3);
    assert.match(warnings[0].message, /autonomous session run failed/);
    for (const session of [idle, running, done]) {
      store.updateSession(session.id, { status: 'idle' });
      store.enqueueSchedulerWake(session.id, 'again');
    }
    await scheduler.tick();
    await scheduler.whenIdle();
    assert.equal(calls.length, 6);
  } finally {
    process.off('unhandledRejection', onRejection);
    store.db.close();
  }
});

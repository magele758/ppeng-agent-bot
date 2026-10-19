import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { cancelSession } from '../dist/runtime/session-control.js';
import { approve } from '../dist/runtime/session-facade.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-fix-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({ title: 'test', mode: 'chat', agentId: 'general' });
  return { store, session, host: { store, sessionAbortControllers: new Map(), backgroundJobAborts: new Map(), emitTrace() {} } };
}

test('repeated late cancellation preserves ended state and outcome [AC:session-lifecycle-state-consistency#AC-1]', t => {
  const { store, session, host } = fixture(t);
  for (const [status, kind] of [['completed', 'completed'], ['idle', 'completed'], ['failed', 'failed']]) {
    store.updateSession(session.id, { status, metadata: { outcome: { kind, reason: kind === 'failed' ? 'model_error' : 'end' } } });
    const before = store.getSession(session.id);
    const messages = store.listMessages(session.id);
    cancelSession(host, session.id);
    cancelSession(host, session.id);
    assert.deepEqual(store.getSession(session.id), before);
    assert.deepEqual(store.listMessages(session.id), messages);
  }
});

test('partial approval or rejection remains waiting until last decision [AC:session-lifecycle-state-consistency#AC-2]', async t => {
  const { store, session } = fixture(t);
  for (const decision of ['approved', 'rejected']) {
    store.updateSession(session.id, { status: 'waiting_approval', metadata: { outcome: { kind: 'waiting_approval' }, interrupt: { kind: 'waiting_approval' } } });
    const first = store.createApproval({ sessionId: session.id, toolName: 'one', reason: 'ask', args: {} });
    const second = store.createApproval({ sessionId: session.id, toolName: 'two', reason: 'ask', args: {} });
    await approve(store, first.id, decision);
    assert.equal(store.getSession(session.id).status, 'waiting_approval');
    assert.equal(store.getSession(session.id).metadata.outcome.kind, 'waiting_approval');
    assert.equal(store.getApproval(second.id).status, 'pending');
    await approve(store, second.id, 'approved');
    assert.equal(store.getSession(session.id).status, 'idle');
  }
});

test('active runs and partially approved waves still cancel [AC:session-lifecycle-state-consistency#AC-3]', async t => {
  const { store, session, host } = fixture(t);
  const controller = new AbortController();
  host.sessionAbortControllers.set(session.id, controller);
  store.updateSession(session.id, { status: 'running', metadata: { outcome: { kind: 'completed' } } });
  cancelSession(host, session.id);
  assert.equal(controller.signal.aborted, true);
  assert.equal(store.getSession(session.id).metadata.outcome.kind, 'aborted');
  host.sessionAbortControllers.clear();
  store.updateSession(session.id, { status: 'waiting_approval', metadata: { interrupt: { kind: 'waiting_approval' } } });
  const first = store.createApproval({ sessionId: session.id, toolName: 'one', reason: 'ask', args: {} });
  const second = store.createApproval({ sessionId: session.id, toolName: 'two', reason: 'ask', args: {} });
  await approve(store, first.id, 'approved');
  cancelSession(host, session.id);
  assert.equal(store.getSession(session.id).status, 'idle');
  assert.equal(store.getSession(session.id).metadata.outcome.kind, 'aborted');
  assert.equal(store.getSession(session.id).metadata.interrupt, undefined);
  assert.equal(store.getApproval(first.id).status, 'approved');
  assert.equal(store.getApproval(second.id).status, 'rejected');
});

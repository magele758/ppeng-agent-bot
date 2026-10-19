import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStateStore } from '../dist/storage.js';
import { armUnattendedApprovalExpiry, disarmAllUnattendedApprovalExpiries, expireDueUnattendedApprovals } from '../dist/approval/unattended-approval.js';

function parked(store) {
  const session = store.createSession({ title: 'expiry scope', mode: 'chat', agentId: 'general', metadata: { approvalWake: { kind: 'unattended', source: 'cron' } } });
  store.claimWriter(session.id, 'old-run');
  store.appendMessage(session.id, 'assistant', [{ type: 'tool_call', toolCallId: 'old-call', name: 'bash', input: {} }]);
  const approval = store.createApproval({ sessionId: session.id, toolName: 'bash', reason: 'probe', args: {} });
  store.updateSession(session.id, { status: 'waiting_approval', metadata: { interrupt: { kind: 'waiting_approval', approvalIds: [approval.id], toolCallIds: ['old-call'], executedToolCallIds: [], stepCursor: 'tools' } } });
  return { session, approval };
}

test('real expiry timer survives parked writer release [AC:unattended-approval-expiry#AC-1]', async () => {
  const store = new SqliteStateStore(':memory:');
  try {
    const { session, approval } = parked(store);
    let finished;
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await store.runWithWriter(session.id, 'old-run', async () => {
        finished = new Promise((resolve, reject) => {
          armUnattendedApprovalExpiry(approval, () => {
            try {
              const expired = expireDueUnattendedApprovals(store, Date.parse(approval.expiresAt));
              assert.throws(() => store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'stale callback' }]), { code: 'WRITER_CLAIM_MISMATCH' });
              resolve(expired);
            }
            catch (error) { reject(error); }
          }, Date.parse(approval.expiresAt) - 10);
        });
      });
      store.releaseWriter(session.id, 'old-run');
      await finished;
    } finally { clearInterval(keepAlive); }
    assert.equal(store.getApproval(approval.id).status, 'rejected');
    assert.equal(store.getSession(session.id).status, 'idle');
    assert.equal(store.getSession(session.id).metadata.interrupt, undefined);
    const results = store.foldMessages(session.id).flatMap(m => m.parts).filter(p => p.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
  } finally { disarmAllUnattendedApprovalExpiries(); store.db.close(); }
});

test('expiring an old pending record cannot clear a newer pause [AC:unattended-approval-expiry#AC-1]', () => {
  const store = new SqliteStateStore(':memory:');
  try {
    const { session, approval } = parked(store);
    store.releaseWriter(session.id, 'old-run');
    const interrupt = { kind: 'waiting_approval', approvalIds: ['new-approval'], toolCallIds: ['new-call'], executedToolCallIds: [], stepCursor: 'tools' };
    store.updateSession(session.id, { metadata: { interrupt } });
    const before = store.foldMessages(session.id);
    expireDueUnattendedApprovals(store, Date.parse(approval.expiresAt));
    assert.equal(store.getApproval(approval.id).status, 'rejected');
    assert.equal(store.getSession(session.id).status, 'waiting_approval');
    assert.deepEqual(store.getSession(session.id).metadata.interrupt, interrupt);
    assert.deepEqual(store.foldMessages(session.id), before);
  } finally { store.db.close(); }
});

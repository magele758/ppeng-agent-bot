import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot, openBot } from '../dist/bots/bot-facade.js';
import { dispatchBotTask, getBotTask, resolveBotPrincipal, tickBotWork, recoverBotWork } from '../dist/bots/bot-work.js';

test('delivery preserves partial output and task-specific artifacts without claiming verification [AC:bot-product-p0#AC-6] [AC:bot-product-p0#AC-7]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-delivery-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const artifact = (id, sessionId, sourceTool = 'report') => store.createArtifactIndex({ id, sessionId, sourceTool,
      fileName: `${id}.md`, mimeType: 'text/markdown', localRelPath: `${id}.md`, totalBytes: 10,
      totalChars: 10, pageSizeChars: 10, totalPages: 1, createdAt: new Date().toISOString() });
    const host = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {},
      log: { warn() {}, info() {}, debug() {}, error() {} },
      async runSession(id) {
        artifact('new-output', id);
        artifact('concurrent-user-input', id, 'user_upload');
        store.appendMessage(id, 'assistant', [{ type: 'text', text: '# Partial report\nCollected the first source.' }]);
        store.updateSession(id, { status: 'failed' });
      } };
    const boss = createBot(host, { name: 'Boss' }), worker = createBot(host, { name: 'Worker' });
    const principal = resolveBotPrincipal(store);
    const chat = openBot(host, worker.id, principal);
    artifact('older-unrelated-output', chat.sessionId);
    const task = dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id, input: 'Research' });
    await tickBotWork(host);
    const finished = getBotTask(store, principal, task.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.delivery.taskId, task.id);
    assert.equal(finished.delivery.sessionId, chat.sessionId);
    assert.match(finished.delivery.report, /Partial report/);
    assert.equal(finished.delivery.verification, 'unverified');
    assert.deepEqual(finished.delivery.artifacts.map(a => a.id), ['new-output']);
    assert.deepEqual(finished.delivery.receipts, []);
    assert.equal(getBotTask(store, { userId: 'stranger' }, task.id), undefined);
    assert.equal(getBotTask(store, principal, task.id).delivery.attempt, 1);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continuing a delivery keeps its exact source version and does not overwrite the original [AC:bot-product-p2#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-delivery-version-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  let execution = 0;
  const host = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {},
    log: { warn() {}, info() {}, debug() {}, error() {} },
    async runSession(id) {
      execution++;
      store.appendMessage(id, 'assistant', [{ type: 'text', text: execution === 1 ? 'Original detailed report' : 'Revised detailed report' }]);
      store.updateSession(id, { status: 'completed' });
    } };
  try {
    const boss = createBot(host, { name: 'Boss' }), worker = createBot(host, { name: 'Worker' });
    const principal = resolveBotPrincipal(store);
    const original = dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id, input: 'Report' });
    await tickBotWork(host);
    await new Promise(resolve => setImmediate(resolve));
    const saved = getBotTask(store, principal, original.id).delivery;
    const sourceDelivery = { taskId: original.id, attempt: 1 };
    const next = dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id,
      input: 'Add a conclusion', sourceDelivery, idempotencyKey: 'revise' });
    assert.deepEqual(getBotTask(store, principal, next.id).sourceDelivery, sourceDelivery);
    const inbox = store.db.prepare("SELECT body FROM bot_work_messages WHERE task_id=? AND kind='task'").get(next.id);
    assert.match(inbox.body, /Original detailed report/);
    assert.throws(() => dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id,
      input: 'Add a conclusion', idempotencyKey: 'revise' }), /Idempotency/);
    await tickBotWork(host);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(getBotTask(store, principal, original.id).delivery, saved);
    assert.equal(getBotTask(store, principal, next.id).delivery.report, 'Revised detailed report');
    assert.throws(() => dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id,
      input: 'Missing version', sourceDelivery: { taskId: original.id, attempt: 999 } }), /version/i);
  } finally { store.db.close();rmSync(dir, { recursive: true, force: true }); }
});

test('interrupted work retains its partial delivery before retiring execution [AC:bot-product-p0#AC-5] [AC:bot-product-p0#AC-7]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-delivery-recovery-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  let finish;
  const host = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {},
    log: { warn() {}, info() {}, debug() {}, error() {} },
    runSession(id) {
      store.appendMessage(id, 'assistant', [{ type: 'text', text: 'Partial output before interruption' }]);
      return new Promise(resolve => { finish = resolve; });
    } };
  try {
    const boss = createBot(host, { name: 'Boss' }), worker = createBot(host, { name: 'Worker' });
    const principal = resolveBotPrincipal(store);
    const task = dispatchBotTask(host, { principal, requesterBotId: boss.id, targetBotId: worker.id, input: 'Research' });
    await tickBotWork(host);
    recoverBotWork(store);
    const result = getBotTask(store, principal, task.id);
    assert.equal(result.status, 'unknown');
    assert.match(result.delivery.report, /Partial output before interruption/);
    assert.equal(result.delivery.executionStatus, 'unknown');
    assert.equal(result.delivery.verification, 'unverified');
  } finally {
    finish?.();
    await new Promise(resolve => setImmediate(resolve));
    store.db.close();rmSync(dir, { recursive: true, force: true });
  }
});

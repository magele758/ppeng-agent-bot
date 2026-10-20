import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { RoutineRunStore, drainRoutineRuns } from '../dist/cron/routine-runtime.js';

function hostFor(store, stateDir, runSession) {
  return {
    store,
    stateDir,
    log: { warn() {}, info() {} },
    cronStore: undefined,
    setCronStore(cronStore) {
      this.cronStore = cronStore;
    },
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
    runSession
  };
}

function routineSessions(store) {
  return store.listSessions().filter((session) => String(session.title).startsWith('Routine:'));
}

test('Bot 定时任务复用主会话且继承免审批 [AC:bot-routine-main-session#AC-1] [AC:bot-routine-main-session#AC-2]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-bot-bypass-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const host = hostFor(store, stateDir, async (id) => {
    const work = store.getSession(id);
    assert.equal(work.metadata.permissionMode, 'bypass');
    store.appendMessage(id, 'assistant', [{ type: 'text', text: 'checked remote' }]);
    return store.getSession(id);
  });
  const bot = createBot(host, { name: '4090 bot' });
  const main = store.getSession(bot.canonicalSessionId);
  store.updateSession(main.id, {
    metadata: { ...main.metadata, permissionMode: 'bypass', userId: 'alice' }
  });
  const job = createCronJob(host, {
    botId: bot.id,
    userId: 'alice',
    name: '4090盯开发复审修复与合并',
    prompt: '盯 Win4090',
    intervalMs: 60000
  });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const done = new RoutineRunStore(store).get(run.id);
  assert.equal(done.sessionId, bot.canonicalSessionId);
  assert.equal(done.mainSessionId, bot.canonicalSessionId);
  assert.equal(done.status, 'completed');
  assert.equal(routineSessions(store).length, 0);
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.permissionMode, 'bypass');
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.canonicalBotChat, true);
  assert.ok(
    store.listMessages(bot.canonicalSessionId).some((message) => message.role === 'user' && JSON.stringify(message).includes('盯 Win4090'))
  );
  store.db.close();
});

test('Bot 定时任务在全程审批的主会话里仍然要批准 [AC:bot-routine-main-session#AC-3]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-bot-ask-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const host = hostFor(store, stateDir, async (id) => {
    assert.equal(store.getSession(id).metadata.permissionMode, 'ask');
    store.createApproval({ sessionId: id, toolName: 'bash', reason: 'Approval required for bash (permissionMode=ask)', args: { command: 'ssh Win4090' } });
    store.updateSession(id, { status: 'waiting_approval' });
    return store.getSession(id);
  });
  const bot = createBot(host, { name: 'Ask bot' });
  const main = store.getSession(bot.canonicalSessionId);
  store.updateSession(main.id, { metadata: { ...main.metadata, permissionMode: 'ask', userId: 'alice' } });
  const job = createCronJob(host, { botId: bot.id, userId: 'alice', name: 'check', prompt: 'inspect', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = new RoutineRunStore(store).get(run.id);
  assert.equal(waiting.sessionId, bot.canonicalSessionId);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.permissionMode, 'ask');
  assert.equal(routineSessions(store).length, 0);
  store.db.close();
});

test('非 Bot 定时任务仍新建会话 [AC:bot-routine-main-session#AC-4]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-plain-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const session = store.createSession({
    title: 'plain',
    mode: 'chat',
    agentId: 'general',
    background: false,
    metadata: { userId: 'alice', permissionMode: 'bypass' }
  });
  const host = hostFor(store, stateDir, async (id) => {
    store.appendMessage(id, 'assistant', [{ type: 'text', text: 'plain done' }]);
    return store.getSession(id);
  });
  const job = createCronJob(host, { sessionId: session.id, name: 'plain job', prompt: 'look', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const done = new RoutineRunStore(store).get(run.id);
  assert.equal(done.status, 'completed');
  assert.notEqual(done.sessionId, session.id);
  assert.equal(store.getSession(done.sessionId).title, 'Routine: plain job');
  assert.equal(store.getSession(done.sessionId).metadata.canonicalBotChat, false);
  assert.equal(store.listMessages(session.id).some((message) => message.role === 'user'), false);
  store.db.close();
});

test('主会话正在回复时 Bot 定时任务插话且不另开会话 [AC:bot-routine-main-session#AC-5]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-bot-steer-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const started = [];
  const host = hostFor(store, stateDir, async (id) => {
    started.push(id);
    return store.getSession(id);
  });
  const bot = createBot(host, { name: 'Busy bot' });
  const main = store.getSession(bot.canonicalSessionId);
  store.updateSession(main.id, {
    status: 'running',
    metadata: { ...main.metadata, permissionMode: 'bypass', userId: 'alice' }
  });
  const job = createCronJob(host, { botId: bot.id, userId: 'alice', name: 'while talking', prompt: '插进来看一眼', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  const parked = new RoutineRunStore(store).get(run.id);
  assert.equal(parked.status, 'queued');
  assert.equal(parked.sessionId, undefined);
  assert.equal(started.length, 0);
  assert.equal(routineSessions(store).length, 0);
  assert.equal(store.getSession(bot.canonicalSessionId).metadata.permissionMode, 'bypass');
  const inbox = store.listUnclaimedInbox(bot.canonicalSessionId);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /插进来看一眼/);
  assert.equal(inbox[0].target, 'next-step');
  await drainRoutineRuns(host);
  assert.equal(store.listUnclaimedInbox(bot.canonicalSessionId).length, 1);
  assert.equal(routineSessions(store).length, 0);
  assert.equal(started.length, 0);
  store.db.close();
});

test('忙碌时插进主会话的其他回复不算定时任务结果，空闲后会再跑一轮 [AC:bot-routine-main-session#AC-1] [AC:bot-routine-main-session#AC-5]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-bot-steer-answer-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const started = [];
  const host = hostFor(store, stateDir, async (id) => {
    started.push(id);
    store.appendMessage(id, 'assistant', [{ type: 'text', text: 'routine answer' }]);
    const current = store.getSession(id);
    store.updateSession(id, {
      status: 'idle',
      metadata: { ...current.metadata, outcome: { kind: 'idle', reason: 'end' } }
    });
    return store.getSession(id);
  });
  const bot = createBot(host, { name: 'Busy bot' });
  const main = store.getSession(bot.canonicalSessionId);
  store.updateSession(main.id, {
    status: 'running',
    metadata: { ...main.metadata, permissionMode: 'bypass', userId: 'alice' }
  });
  const job = createCronJob(host, { botId: bot.id, userId: 'alice', name: 'while talking', prompt: '插进来看一眼', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  await drainRoutineRuns(host);
  const parked = new RoutineRunStore(store).get(run.id);
  assert.equal(parked.status, 'queued');
  const inbox = store.listUnclaimedInbox(bot.canonicalSessionId);
  assert.equal(inbox.length, 1);
  store.appendMessage(bot.canonicalSessionId, 'user', [{ type: 'text', text: inbox[0].text }], { key: inbox[0].key });
  store.db.prepare('UPDATE session_inbox SET claimed_at=? WHERE id=?').run(new Date().toISOString(), inbox[0].id);
  store.appendMessage(bot.canonicalSessionId, 'assistant', [{ type: 'text', text: 'Completed other work' }]);
  const busy = store.getSession(bot.canonicalSessionId);
  store.updateSession(bot.canonicalSessionId, {
    status: 'idle',
    metadata: { ...busy.metadata, outcome: { kind: 'idle', reason: 'end' } }
  });
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const done = new RoutineRunStore(store).get(run.id);
  assert.equal(started.length, 1);
  assert.equal(started[0], bot.canonicalSessionId);
  assert.equal(done.sessionId, bot.canonicalSessionId);
  assert.equal(done.status, 'completed');
  assert.match(done.result, /routine answer/);
  assert.equal(routineSessions(store).length, 0);
  store.db.close();
});

test('已删除的 Bot 定时任务不再开会话 [AC:bot-routine-main-session#AC-6]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'routine-bot-removed-'));
  const store = new SqliteStateStore(join(stateDir, 'state.db'));
  const started = [];
  const host = hostFor(store, stateDir, async (id) => {
    started.push(id);
    return store.getSession(id);
  });
  const bot = createBot(host, { name: 'Gone bot' });
  const main = store.getSession(bot.canonicalSessionId);
  store.updateSession(main.id, { metadata: { ...main.metadata, permissionMode: 'bypass', userId: 'alice' } });
  const job = createCronJob(host, { botId: bot.id, userId: 'alice', name: 'removed', prompt: '不要再跑', intervalMs: 60000 });
  const run = new RoutineRunStore(store).enqueue(job, new Date().toISOString());
  host.cronStore.remove(job.id);
  await drainRoutineRuns(host);
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = new RoutineRunStore(store).get(run.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.sessionId, undefined);
  assert.equal(started.length, 0);
  assert.equal(routineSessions(store).length, 0);
  assert.equal(
    store.listMessages(bot.canonicalSessionId).some((message) => JSON.stringify(message).includes('不要再跑')),
    false
  );
  store.db.close();
});

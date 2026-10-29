import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore } from '../dist/storage.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (!parent.endsWith('/src/bots/goals/runtime-host.ts') || !specifier.endsWith('.js')) return nextResolve(specifier, context);
    // Source intake must load the new store helper. Other siblings stay compiled so strip-types does not parse parameter properties.
    if (specifier === './store.js') return nextResolve('./store.ts', context);
    return nextResolve(specifier, { ...context, parentURL: parent.replace('/src/bots/goals/runtime-host.ts', '/dist/bots/goals/runtime-host.js') });
  }
});

// Static import cannot install the resolver before Node loads runtime-host's .js specifiers.
const { prepareGoalIntake } = await import('../src/bots/goals/runtime-host.ts');

function openChat(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-intake-hot-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({
    title: 'Bot',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'b', canonicalBotChat: true, userId: 'u', tenantId: 't' }
  });
  const host = {
    store,
    isRunning: () => false,
    cancel() {},
    async run() {},
    capabilities: () => ({ registeredTools: [], enabledStrategies: ['direct'] }),
    judge: () => new Promise(() => {})
  };
  return { store, session, host };
}

test('a hanging goal judge does not block turn start or drop chat [AC:goal-intake-hot-path#AC-1] [AC:goal-intake-hot-path#AC-3]', async (t) => {
  const { store, session, host } = openChat(t);
  const text = '你好，今天怎么样';
  store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
  requestHumanRun(store, session.id);
  const started = Date.now();
  await prepareGoalIntake(host, store.getSession(session.id)!);
  assert.ok(Date.now() - started < 300);
  const live = store.getSession(session.id);
  assert.equal(live?.id, session.id);
  assert.ok(store.foldMessages(session.id).some((message: { role: string; parts: Array<{ type: string; text?: string }> }) => message.role === 'user' && message.parts.some(part => part.type === 'text' && part.text === text)));
});

test('a thrown intake write does not fail the turn [AC:goal-intake-hot-path#AC-2]', async (t) => {
  const { store, session, host } = openChat(t);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: '请修复登录超时' }]);
  requestHumanRun(store, session.id);
  const original = store.setDaemonControl.bind(store);
  store.setDaemonControl = (key: string, value: unknown) => {
    if (key.startsWith('bot.goal-intake:') || key.startsWith('bot_goals:')) throw new Error('database is locked');
    original(key, value);
  };
  const started = Date.now();
  await prepareGoalIntake(host, store.getSession(session.id)!);
  assert.ok(Date.now() - started < 300);
  assert.equal(store.getSession(session.id)?.id, session.id);
});

test('a locked database does not hold turn start for the 5s busy timeout [AC:goal-intake-hot-path#AC-2]', async (t) => {
  const { store, session, host } = openChat(t);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: '请修复登录超时' }]);
  requestHumanRun(store, session.id);
  const other = new DatabaseSync(store.dbPath);
  t.after(() => other.close());
  other.exec('BEGIN IMMEDIATE');
  const started = Date.now();
  await prepareGoalIntake(host, store.getSession(session.id)!);
  const elapsed = Date.now() - started;
  other.exec('ROLLBACK');
  assert.ok(elapsed < 1000, `intake waited ${elapsed}ms`);
  assert.equal(store.getSession(session.id)?.id, session.id);
});

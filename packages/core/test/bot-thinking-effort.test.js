import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ValidationError, writeThinkingEffortSettings } from '../dist/index.js';
import { normalizeBotThinkingEffort, readBotThinkingEffort } from '../dist/bots/index.js';
import { applyThinkingEffortToTurn } from '../dist/model/thinking-effort-settings.js';
import { SqliteStateStore } from '../dist/storage.js';
import { spawnSubagent, spawnTeammate } from '../dist/runtime/spawn-host.js';
import { inheritModelOverride } from '../dist/runtime/spawn-policy.js';

function probe() {
  const efforts = [];
  return {
    efforts,
    adapter: {
      name: 'bot-thinking-effort-probe',
      async runTurn(input) {
        efforts.push(input.reasoningEffort);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'summary';
      }
    }
  };
}

async function withRuntime(run) {
  const { efforts, adapter } = probe();
  const dir = mkdtempSync(join(tmpdir(), 'bot-thinking-effort-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: adapter
  });
  try {
    await run({ efforts, runtime });
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function say(runtime, sessionId, text) {
  if (text) runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text }]);
  const before = runtime.store.listMessages(sessionId).length;
  await runtime.runSession(sessionId);
  assert.ok(runtime.store.listMessages(sessionId).length > before);
}

function kvStore(level) {
  const map = new Map();
  if (level) map.set('thinking_effort_settings', { level, updatedAt: '' });
  return {
    getDaemonControl: (key) => map.get(key),
    setDaemonControl: (key, value) => map.set(key, value)
  };
}

test('updateBot saves, reads back and clears thinkingEffort on every bot chat [AC:bot-thinking-effort#AC-1]', async () => {
  await withRuntime(async ({ runtime }) => {
    const bot = runtime.createBot({ name: 'Effort Bot' });
    const perUser = runtime.openBot(bot.id, { userId: 'u1' });

    for (const level of ['off', 'low', 'medium', 'high']) {
      runtime.updateBot(bot.id, { thinkingEffort: level });
      assert.equal(readBotThinkingEffort(runtime.getSession(bot.canonicalSessionId)?.metadata), level);
      assert.equal(readBotThinkingEffort(runtime.getSession(perUser.sessionId)?.metadata), level);
    }

    assert.equal(normalizeBotThinkingEffort('off'), 'off');
    assert.equal(normalizeBotThinkingEffort(null), null);
    assert.equal(normalizeBotThinkingEffort(''), null);
    assert.throws(() => normalizeBotThinkingEffort('max'), ValidationError);
    assert.throws(() => runtime.updateBot(bot.id, { thinkingEffort: 'turbo' }), ValidationError);
    assert.throws(() => runtime.updateBot(bot.id, { thinkingEffort: 'turbo', name: 'Renamed' }), ValidationError);
    assert.equal(runtime.getBot(bot.id).name, 'Effort Bot');
    assert.equal(readBotThinkingEffort(runtime.getSession(bot.canonicalSessionId)?.metadata), 'high');

    runtime.updateBot(bot.id, { thinkingEffort: null });
    assert.ok(!('thinkingEffort' in runtime.getSession(bot.canonicalSessionId).metadata));
    assert.ok(!('thinkingEffort' in runtime.getSession(perUser.sessionId).metadata));
  });
});

test('a newly opened bot chat inherits the saved thinking effort pin [AC:bot-thinking-effort#AC-1]', async () => {
  await withRuntime(async ({ runtime }) => {
    const bot = runtime.createBot({ name: 'Inherit Bot' });
    runtime.updateBot(bot.id, { thinkingEffort: 'off' });
    const later = runtime.openBot(bot.id, { userId: 'u2' });
    assert.equal(readBotThinkingEffort(runtime.getSession(later.sessionId)?.metadata), 'off');
  });
});

test('a pinned bot chat overrides the global thinking effort on the next turn [AC:bot-thinking-effort#AC-2]', async () => {
  await withRuntime(async ({ efforts, runtime }) => {
    writeThinkingEffortSettings(runtime.store, { level: 'high' });
    const bot = runtime.createBot({ name: 'Low Bot' });
    runtime.updateBot(bot.id, { thinkingEffort: 'low' });
    const chat = runtime.openBot(bot.id);
    await say(runtime, chat.sessionId, 'think less');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'low'));
  });
  assert.equal(applyThinkingEffortToTurn({ text: 'x' }, kvStore('high'), 'low').reasoningEffort, 'low');
  assert.equal(applyThinkingEffortToTurn({ text: 'x' }, kvStore('off'), 'medium').reasoningEffort, 'medium');
});

test('an unpinned bot chat and a plain chat both follow the global thinking effort [AC:bot-thinking-effort#AC-3]', async () => {
  await withRuntime(async ({ efforts, runtime }) => {
    writeThinkingEffortSettings(runtime.store, { level: 'medium' });
    const bot = runtime.createBot({ name: 'Follow Bot' });
    const chat = runtime.openBot(bot.id);
    await say(runtime, chat.sessionId, 'follow global');
    const plain = runtime.createChatSession({ title: 'plain', message: 'hello' });
    await say(runtime, plain.id, 'also follow global');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'medium'));
  });
  assert.equal(applyThinkingEffortToTurn({ text: 'x' }, kvStore('medium'), undefined).reasoningEffort, 'medium');
  assert.equal('reasoningEffort' in applyThinkingEffortToTurn({ reasoningEffort: 'low' }, kvStore(), undefined), false);
});

test('clearing the pin falls back to the global setting, off included [AC:bot-thinking-effort#AC-4]', async () => {
  await withRuntime(async ({ efforts, runtime }) => {
    writeThinkingEffortSettings(runtime.store, { level: 'medium' });
    const bot = runtime.createBot({ name: 'Unpin Bot' });
    runtime.updateBot(bot.id, { thinkingEffort: 'high' });
    const chat = runtime.openBot(bot.id);
    await say(runtime, chat.sessionId, 'pinned first');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'high'));
    efforts.length = 0;

    runtime.updateBot(bot.id, { thinkingEffort: null });
    await say(runtime, chat.sessionId, 'unpinned now');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'medium'));
    efforts.length = 0;

    writeThinkingEffortSettings(runtime.store, { level: 'off' });
    await say(runtime, chat.sessionId, 'global off');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === undefined));
  });
});

test('a bot pinned off sends no thinking effort while the global level is high [AC:bot-thinking-effort#AC-7]', async () => {
  await withRuntime(async ({ efforts, runtime }) => {
    writeThinkingEffortSettings(runtime.store, { level: 'high' });
    const bot = runtime.createBot({ name: 'Plain Model Bot' });
    runtime.updateBot(bot.id, { thinkingEffort: 'off' });
    const chat = runtime.openBot(bot.id);
    await say(runtime, chat.sessionId, 'no effort please');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === undefined));
    efforts.length = 0;

    const plain = runtime.createChatSession({ title: 'plain', message: 'hello' });
    await say(runtime, plain.id, 'global still high');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'high'));
  });
  const next = applyThinkingEffortToTurn({ reasoningEffort: 'high', text: 'keep' }, kvStore('high'), 'off');
  assert.equal('reasoningEffort' in next, false);
  assert.equal(next.text, 'keep');
});

function spawnHost(store) {
  return {
    store,
    repoRoot: '/tmp',
    stateDir: '/tmp',
    workspaceManager: {},
    sandbox: undefined,
    setSandbox() {},
    backgroundJobAborts: new Map(),
    async runSession(id) {
      return store.getSession(id);
    }
  };
}

function runContext(session) {
  return {
    repoRoot: '/tmp',
    stateDir: '/tmp',
    session,
    agent: { id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] }
  };
}

test('subagents and teammates of a pinned bot keep its thinking effort [AC:bot-thinking-effort#AC-8]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-effort-spawn-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    store.upsertAgent({ id: 'general', name: 'General', role: 'general', instructions: '', capabilities: [] });
    const pinned = store.createSession({
      title: 'pinned parent',
      mode: 'chat',
      agentId: 'general',
      metadata: { botId: 'b', canonicalBotChat: true, thinkingEffort: 'off' }
    });
    await spawnSubagent(spawnHost(store), runContext(pinned), 'go', undefined, {});
    await spawnTeammate(spawnHost(store), runContext(pinned), { name: 'mate-e', role: 'helper', prompt: 'hi' });
    const kids = store.listSessions().filter((s) => s.parentSessionId === pinned.id);
    assert.equal(kids.length, 2);
    for (const kid of kids) assert.equal(kid.metadata.thinkingEffort, 'off');

    const unpinned = store.createSession({
      title: 'unpinned parent',
      mode: 'chat',
      agentId: 'general',
      metadata: { botId: 'c', canonicalBotChat: true }
    });
    await spawnSubagent(spawnHost(store), runContext(unpinned), 'go', undefined, {});
    for (const kid of store.listSessions().filter((s) => s.parentSessionId === unpinned.id)) {
      assert.ok(!('thinkingEffort' in kid.metadata));
    }
    assert.deepEqual(inheritModelOverride({ thinkingEffort: 'turbo' }), {});
    assert.deepEqual(inheritModelOverride({ thinkingEffort: 'medium' }), { thinkingEffort: 'medium' });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

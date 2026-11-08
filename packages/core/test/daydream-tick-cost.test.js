import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BotDaydreamService } from '../dist/daydream/index.js';
import { RawAgentRuntime } from '../dist/runtime.js';

test('one scheduler round lists bots once and single-bot lookups never rescan all bots [AC:daydream-tick-cost#AC-1]', async () => {
  const db = new DatabaseSync(':memory:');
  const ids = Array.from({ length: 50 }, (_, i) => `bot${i}`);
  const kv = new Map(ids.map(id => [`bot_daydream:${id}`, { enabled: false, timezone: 'UTC', dailyAt: '03:00', memoryPolicy: 'auto', skillPolicy: 'propose', collaborationEnabled: true, maxChunks: 20, effectiveFrom: '2026-11-01T00:00:00Z' }]));
  let listed = 0;
  const service = new BotDaydreamService({
    db,
    settingsStore: { getDaemonControl: k => kv.get(k), setDaemonControl: (k, v) => kv.set(k, v) },
    listBots: () => { listed++; return ids.map(id => ({ id, tenantId: 't' })); },
    getBot: id => (ids.includes(id) ? { id, tenantId: 't' } : undefined),
    readEvidence: async () => [],
    complete: async () => '{"candidates":[]}',
    saveMemory: async () => null,
    captureSkill: async () => null,
    now: () => Date.parse('2026-11-03T04:00:00Z')
  });
  await service.tick();
  assert.equal(listed, 1);
  for (const id of ids) {
    service.getSettings(id);
    service.listRuns(id);
    service.isBusy(id);
  }
  assert.equal(listed, 1);
  assert.throws(() => service.getSettings('missing'), /Bot not found/);
  db.close();
});

test('scheduled review reads each bot conversation a bounded number of times and bot listing keeps working [AC:daydream-tick-cost#AC-2]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daydream-tick-cost-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: { name: 'tick-cost', runTurn: async () => ({ stopReason: 'end', assistantParts: [] }), completeText: async () => '{"decisions":[],"feedbackDecisions":[]}' }
  });
  runtime.emitTrace = () => {};
  t.after(async () => { await runtime.destroy(); rmSync(dir, { recursive: true, force: true }); });
  const count = 30;
  for (let i = 0; i < count; i++) {
    const bot = runtime.createBot({ name: `Bot ${i}` });
    runtime.daydream.local.patchSettings(bot.id, { dailyAt: '23:59', timezone: 'UTC' });
  }
  const getSession = runtime.store.getSession.bind(runtime.store);
  let reads = 0;
  runtime.store.getSession = id => { reads++; return getSession(id); };
  await runtime.daydream.tick();
  runtime.store.getSession = getSession;
  assert.ok(reads <= count * 10, `conversation reads ${reads} grew with bots squared`);
  assert.ok(runtime.listBots({ includeHidden: true }).length >= count);
});

test('owned bot lookup skips full session reads and detects a missing chat [AC:history-startup-contention#AC-1]', async t => {
  const { tryBotDaydreamPrincipal } = await import('../dist/runtime/daydream-evidence.js');
  const { setBotDefinitionOwner } = await import('../dist/bots/bot-identity.js');
  const { SqliteStateStore } = await import('../dist/storage.js');
  const dir = mkdtempSync(join(tmpdir(), 'history-owner-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const chat = store.createSession({ title: 'chat', agentId: 'general', mode: 'chat' });
  store.getBot = () => ({ canonicalSessionId: chat.id });
  const owner = { userId: 'owner', tenantId: 'tenant' };
  setBotDefinitionOwner(store, 'owned', owner);
  store.getSession = () => assert.fail('full session loaded for known owner');
  assert.deepEqual(tryBotDaydreamPrincipal(store, 'owned'), owner);
  store.db.prepare('DELETE FROM sessions WHERE id=?').run(chat.id);
  assert.equal(tryBotDaydreamPrincipal(store, 'owned'), undefined);
});

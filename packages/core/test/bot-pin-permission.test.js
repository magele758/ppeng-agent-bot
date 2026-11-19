import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { createProductAdminTools } from '../dist/tools/product-admin-tools.js';
import { setCatalogDefaultRef, upsertProvider } from '../dist/model/provider-catalog.js';

const MODEL_A = { providerId: 'prov-a', modelId: 'alpha-1' };
const MODEL_B = { providerId: 'prov-b', modelId: 'beta-1' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-pin-permission-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  for (const [id, model] of [['prov-a', 'alpha-1'], ['prov-b', 'beta-1']]) {
    upsertProvider(store, {
      id,
      name: id,
      kind: 'openai-compatible',
      baseUrl: `https://${id}.invalid/v1`,
      apiKey: `key-${id}`,
      models: [{ id: model, enabled: true }]
    });
  }
  setCatalogDefaultRef(store, MODEL_A);
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {} };
  const rooms = new BotRoomService(
    { store, createChatSession: (input) => createChatSession(facade, input), runSession: async () => {}, cancelSession() {} },
    { recover: false }
  );
  const tools = createProductAdminTools({ store, facade, rooms, toolNames: () => tools.map((tool) => tool.name) });
  const memory = store.agentMemory();
  memory.upsertTenant({ id: 'tenant', name: 'Tenant' });
  for (const [userId, role] of [['carol', 'admin'], ['mallory', 'member'], ['alice', 'member']]) {
    memory.upsertUser({ id: userId, status: 'active' });
    memory.addMembership({ userId, tenantId: 'tenant', role });
  }
  const operator = createChatSession(facade, { title: 'operator', agentId: 'general' });
  const as = (userId) => createChatSession(facade, { title: userId, agentId: 'general', metadata: { userId, tenantId: 'tenant' } });
  return {
    store,
    tools,
    operator,
    carol: as('carol'),
    mallory: as('mallory'),
    alice: as('alice'),
    close() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const agent = { id: 'general', name: 'General', role: 'assistant', instructions: 'hello', capabilities: ['chat', 'tool-use'] };

async function call(fx, session, name, args) {
  const tool = fx.tools.find((item) => item.name === name);
  assert.ok(tool, name);
  const result = await tool.execute({ session, agent }, args);
  return { ok: result.ok, body: JSON.parse(result.content) };
}

async function pins(fx, botId, session = fx.operator) {
  const got = await call(fx, session, 'bot_get', { bot: botId });
  assert.equal(got.ok, true);
  return { modelOverride: got.body.bot.modelOverride, thinkingEffort: got.body.bot.thinkingEffort };
}

test('bot_update cannot change the pins of a Bot without an owner unless an admin asks [AC:bot-pin-permission#AC-5]', async () => {
  const fx = fixture();
  try {
    const created = await call(fx, fx.operator, 'bot_create', { name: 'Shared tool Bot' });
    assert.equal(created.ok, true);
    const botId = created.body.bot.id;
    assert.equal((await call(fx, fx.operator, 'bot_update', { bot: botId, modelOverride: MODEL_A, thinkingEffort: 'low' })).ok, true);

    for (const args of [{ modelOverride: MODEL_B }, { modelOverride: null }, { thinkingEffort: 'high' }, { thinkingEffort: null }]) {
      const denied = await call(fx, fx.mallory, 'bot_update', { bot: botId, ...args });
      assert.equal(denied.ok, false, JSON.stringify(args));
      assert.match(JSON.stringify(denied.body), /bot_pin_forbidden/);
      assert.deepEqual(await pins(fx, botId), { modelOverride: MODEL_A, thinkingEffort: 'low' });
    }
    const repeated = await call(fx, fx.mallory, 'bot_update', { bot: botId, modelOverride: MODEL_A, thinkingEffort: 'low' });
    assert.equal(repeated.ok, true);
    assert.deepEqual(await pins(fx, botId), { modelOverride: MODEL_A, thinkingEffort: 'low' });

    const byAdmin = await call(fx, fx.carol, 'bot_update', { bot: botId, modelOverride: MODEL_B, thinkingEffort: 'high' });
    assert.equal(byAdmin.ok, true);
    assert.deepEqual(await pins(fx, botId), { modelOverride: MODEL_B, thinkingEffort: 'high' });

    const own = await call(fx, fx.alice, 'bot_create', { name: 'Alice tool Bot' });
    assert.equal(own.ok, true);
    const byOwner = await call(fx, fx.alice, 'bot_update', { bot: own.body.bot.id, modelOverride: MODEL_B, thinkingEffort: 'medium' });
    assert.equal(byOwner.ok, true);
    assert.deepEqual(await pins(fx, own.body.bot.id, fx.alice), { modelOverride: MODEL_B, thinkingEffort: 'medium' });
  } finally {
    fx.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { createProductAdminTools } from '../dist/tools/product-admin-tools.js';
import { syncBotAgentSpecs } from '../dist/bots/bot-facade.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'product-admin-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {}
  };
  const rooms = new BotRoomService(
    {
      store,
      createChatSession: (input) => createChatSession(facade, input),
      runSession: async () => {},
      cancelSession() {}
    },
    { recover: false }
  );
  const tools = createProductAdminTools({
    store,
    facade,
    rooms,
    toolNames: () => tools.map((tool) => tool.name)
  });
  const session = createChatSession(facade, { title: '私聊', agentId: 'general' });
  const agent = {
    id: 'general',
    name: 'General',
    role: '通用助手',
    instructions: 'hello',
    capabilities: ['chat', 'tool-use']
  };
  return { dir, store, facade, rooms, tools, session, agent };
}

async function call(fx, name, args, session = fx.session) {
  const tool = fx.tools.find((item) => item.name === name);
  assert.ok(tool, name);
  const result = await tool.execute({ session, agent: fx.agent }, args ?? {});
  const body = JSON.parse(result.content);
  return { ok: result.ok, body };
}

const GENERAL = {
  id: 'general',
  name: 'General',
  role: '通用助手',
  instructions: 'hello',
  capabilities: ['chat', 'coding', 'tool-use', 'analysis']
};

test('create a bot and see it on the roster [AC:bot-product-admin#AC-1]', async () => {
  const fx = fixture();
  const created = await call(fx, 'bot_create', { name: '资料员', title: '文档助手', description: '读文档' });
  assert.equal(created.ok, true);
  assert.equal(created.body.bot.name, '资料员');
  assert.equal(created.body.bot.title, '文档助手');
  assert.equal(created.body.bot.description, '读文档');
  const listed = await call(fx, 'bot_list');
  assert.ok(listed.body.bots.some((bot) => bot.name === '资料员' && bot.title === '文档助手'));
  fx.store.db.close();
});

test('update bot name, title, description, and turn cap [AC:bot-product-admin#AC-2]', async () => {
  const fx = fixture();
  const created = await call(fx, 'bot_create', { name: 'Alpha' });
  const updated = await call(fx, 'bot_update', {
    bot: created.body.bot.id,
    name: 'Beta',
    title: '新头衔',
    description: '新简介',
    maxTurns: 48
  });
  assert.equal(updated.ok, true);
  const again = await call(fx, 'bot_get', { bot: 'Beta' });
  assert.equal(again.body.bot.name, 'Beta');
  assert.equal(again.body.bot.title, '新头衔');
  assert.equal(again.body.bot.description, '新简介');
  assert.equal(again.body.bot.maxTurns, 48);
  fx.store.db.close();
});

test('create a group chat with members [AC:bot-product-admin#AC-3]', async () => {
  const fx = fixture();
  const a = await call(fx, 'bot_create', { name: 'Alpha' });
  const b = await call(fx, 'bot_create', { name: 'Beta' });
  const room = await call(fx, 'bot_room_create', {
    title: '项目讨论',
    botIds: [a.body.bot.name, b.body.bot.id]
  });
  assert.equal(room.ok, true);
  assert.equal(room.body.room.title, '项目讨论');
  assert.deepEqual(room.body.room.botIds.sort(), [a.body.bot.id, b.body.bot.id].sort());
  const listed = await call(fx, 'bot_room_list');
  assert.ok(listed.body.rooms.some((item) => item.id === room.body.room.id && item.title === '项目讨论'));
  fx.store.db.close();
});

test('update group chat title and turn budget [AC:bot-product-admin#AC-4]', async () => {
  const fx = fixture();
  const a = await call(fx, 'bot_create', { name: 'Alpha' });
  const b = await call(fx, 'bot_create', { name: 'Beta' });
  const room = await call(fx, 'bot_room_create', { title: '旧标题', botIds: [a.body.bot.id, b.body.bot.id] });
  const updated = await call(fx, 'bot_room_update', {
    roomId: room.body.room.id,
    title: '新标题',
    maxBotTurns: 3
  });
  assert.equal(updated.ok, true);
  const again = await call(fx, 'bot_room_get', { roomId: room.body.room.id });
  assert.equal(again.body.room.title, '新标题');
  assert.equal(again.body.room.maxBotTurns, 3);
  fx.store.db.close();
});

test('deleting a group chat requires confirm and keeps the bots [AC:bot-product-admin#AC-5]', async () => {
  const fx = fixture();
  const a = await call(fx, 'bot_create', { name: 'Alpha' });
  const b = await call(fx, 'bot_create', { name: 'Beta' });
  const room = await call(fx, 'bot_room_create', { title: '要删的群', botIds: [a.body.bot.id, b.body.bot.id] });
  const refused = await call(fx, 'bot_room_delete', { roomId: room.body.room.id, confirm: false });
  assert.equal(refused.ok, false);
  assert.match(refused.body.error, /confirm/);
  const still = await call(fx, 'bot_room_get', { roomId: room.body.room.id });
  assert.equal(still.body.room.title, '要删的群');
  const deleted = await call(fx, 'bot_room_delete', { roomId: room.body.room.id, confirm: true });
  assert.equal(deleted.ok, true);
  const gone = await call(fx, 'bot_room_get', { roomId: room.body.room.id });
  assert.equal(gone.ok, false);
  const bots = await call(fx, 'bot_list');
  assert.ok(bots.body.bots.some((bot) => bot.name === 'Alpha'));
  assert.ok(bots.body.bots.some((bot) => bot.name === 'Beta'));
  fx.store.db.close();
});

test('private chats can manage the product; group-chat turns cannot [AC:bot-product-admin#AC-6]', async () => {
  const fx = fixture();
  const created = await call(fx, 'bot_create', { name: 'Alpha', description: '助手' });
  const botAgent = fx.store.getAgent(created.body.bot.id);
  assert.match(botAgent.instructions, /bot_create/);
  assert.match(botAgent.instructions, /Do not claim you lack that ability/);
  fx.store.upsertAgent({ ...botAgent, instructions: 'stale' });
  syncBotAgentSpecs(fx.store);
  assert.match(fx.store.getAgent(created.body.bot.id).instructions, /bot_room_create/);

  const prefix = new PromptBuilder({ store: fx.store, repoRoot: fx.dir, stateDir: fx.dir }).buildStablePrefix({
    agent: GENERAL,
    session: fx.session,
    repoRoot: fx.dir
  });
  assert.match(prefix, /bot_create/);
  assert.match(prefix, /Do not claim you lack that ability/);

  const wanted = ['bot_create', 'bot_update', 'bot_room_create', 'bot_room_update', 'lab_settings_update'];
  const general = filterToolsForSession({
    env: {},
    tools: fx.tools,
    agent: GENERAL,
    session: fx.session,
    settingsStore: fx.store
  }).tools.map((tool) => tool.name);
  for (const name of wanted) assert.ok(general.includes(name), name);

  const canonical = fx.store.getSession(created.body.bot.canonicalSessionId);
  const botTurn = filterToolsForSession({
    env: {},
    tools: fx.tools,
    agent: fx.store.getAgent(created.body.bot.id),
    session: canonical,
    settingsStore: fx.store
  }).tools.map((tool) => tool.name);
  for (const name of wanted) assert.ok(botTurn.includes(name), name);

  const room = await call(fx, 'bot_room_create', {
    title: '群',
    botIds: [created.body.bot.id, (await call(fx, 'bot_create', { name: 'Beta' })).body.bot.id]
  });
  const roomTurn = filterToolsForSession({
    env: {},
    tools: fx.tools,
    agent: fx.store.getAgent(created.body.bot.id),
    session: { ...canonical, metadata: { ...canonical.metadata, roomId: room.body.room.id } },
    settingsStore: fx.store
  }).tools.map((tool) => tool.name);
  for (const name of wanted) assert.equal(roomTurn.includes(name), false, name);

  const child = filterToolsForSession({
    env: {},
    tools: fx.tools,
    agent: GENERAL,
    session: { ...fx.session, mode: 'subagent' },
    settingsStore: fx.store
  }).tools.map((tool) => tool.name);
  for (const name of wanted) assert.equal(child.includes(name), false, name);
  fx.store.db.close();
});

test('saved settings change and secrets stay out of the result [AC:bot-product-admin#AC-7]', async () => {
  const fx = fixture();
  const updated = await call(fx, 'lab_settings_update', {
    area: 'memory',
    patch: { curatorMode: 'observe_only' }
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.body.settings.curatorMode, 'observe_only');
  const read = await call(fx, 'lab_settings_get', { area: 'memory' });
  assert.equal(read.body.settings.curatorMode, 'observe_only');
  const text = JSON.stringify(read.body) + JSON.stringify(updated.body);
  assert.doesNotMatch(text, /sk-|apiKey|secretKey|token|password/);
  const listed = await call(fx, 'lab_settings_list');
  assert.ok(listed.body.areas.some((area) => area.area === 'memory'));
  fx.store.db.close();
});

test('a saved model provider key is not echoed [AC:bot-product-admin#AC-8]', async () => {
  const fx = fixture();
  const secret = 'sk-test-secret-value-12345678';
  const saved = await call(fx, 'lab_model_provider_upsert', {
    name: 'Example',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'demo-model',
    apiKey: secret
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.body.provider.hasApiKey, true);
  assert.equal(saved.body.provider.name, 'Example');
  const listed = await call(fx, 'lab_model_providers_list');
  const text = JSON.stringify(saved.body) + JSON.stringify(listed.body);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('apiKeyMasked'), false);
  fx.store.db.close();
});

test('create and rename a functional group and a chat session [AC:bot-product-admin#AC-9]', async () => {
  const fx = fixture();
  const group = await call(fx, 'bot_group_create', { name: '研究' });
  assert.equal(group.ok, true);
  const renamed = await call(fx, 'bot_group_rename', { groupId: group.body.group.id, name: '写作' });
  assert.equal(renamed.ok, true);
  const groups = await call(fx, 'bot_group_list');
  assert.ok(groups.body.groups.some((item) => item.id === group.body.group.id && item.name === '写作'));

  const session = await call(fx, 'lab_session_create', { title: '新会话' });
  assert.equal(session.ok, true);
  assert.equal(session.body.session.title, '新会话');
  const next = await call(fx, 'lab_session_update', { sessionId: session.body.session.id, title: '改名后' });
  assert.equal(next.ok, true);
  const listed = await call(fx, 'lab_session_list');
  assert.ok(listed.body.sessions.some((item) => item.id === session.body.session.id && item.title === '改名后'));
  fx.store.db.close();
});

test('permission mode cannot be set to bypass, including padded text', async () => {
  const fx = fixture();
  const session = await call(fx, 'lab_session_create', { title: '权限' });
  assert.equal(session.ok, true);
  for (const permissionMode of ['bypass', ' bypass ', 'bypass\n']) {
    const refused = await call(fx, 'lab_session_update', { sessionId: session.body.session.id, permissionMode });
    assert.equal(refused.ok, false, permissionMode);
    assert.match(refused.body.error, /bypass/);
  }
  const stored = fx.store.getSession(session.body.session.id);
  assert.notEqual(stored?.metadata?.permissionMode, 'bypass');
  const allowed = await call(fx, 'lab_session_update', { sessionId: session.body.session.id, permissionMode: 'ask' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.body.session.permissionMode, 'ask');
  fx.store.db.close();
});

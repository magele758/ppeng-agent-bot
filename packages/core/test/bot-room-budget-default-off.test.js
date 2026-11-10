import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, ensureBotRoomSchema, readRoomSettings, writeRoomSettings } from '../dist/rooms/index.js';

const principal = { userId: 'owner', tenantId: 'team' };

/** Bots and a host whose member runs are scripted per bot name. The service is built by the caller so rows can be seeded first. */
function fixture(names = ['Alpha', 'Beta', 'Gamma']) {
  const dir = mkdtempSync(join(tmpdir(), 'room-budget-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = names.map(name => createBot(facade, { name }));
  for (const bot of bots) store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const scripts = new Map();
  const cancelled = [];
  const nameOf = id => bots.find(bot => bot.id === store.getSession(id).metadata.botId)?.name;
  const say = (id, text) => store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async (id, options) => {
      store.updateSession(id, { status: 'running' });
      const script = scripts.get(nameOf(id)) ?? (async api => { api.say(`reply:${nameOf(id)}`); api.finish(); });
      await script({
        id,
        say: text => say(id, text),
        spend: usd => store.updateSession(id, { metadata: { ...store.getSession(id).metadata, usageCostUsd: (store.getSession(id).metadata.usageCostUsd ?? 0) + usd } }),
        modelDone: toolCalls => options.onEvent({ type: 'model_done', stopReason: toolCalls ? 'tool_use' : 'end', assistant: { parts: toolCalls ? Array.from({ length: toolCalls }, (_, i) => ({ type: 'tool_call', toolCallId: `c${i}`, name: 'bash', input: {} })) : [{ type: 'text', text: 'final' }] } }),
        finish: () => { if (store.getSession(id).status === 'running') store.updateSession(id, { status: 'idle' }); },
        cancelledNow: () => store.getSession(id).status === 'failed'
      });
    },
    // Same effect as the runtime: only a live run is stopped, and it ends failed with an aborted outcome.
    cancelSession: id => {
      const session = store.getSession(id);
      if (session.status !== 'running') return;
      cancelled.push(nameOf(id));
      store.updateSession(id, { status: 'failed', metadata: { ...session.metadata, outcome: { kind: 'aborted', reason: 'abort' } } });
    }
  };
  return { store, host, bots, scripts, cancelled, ids: bots.map(bot => bot.id) };
}
function botReplies(f, rooms, roomId) {
  return rooms.messages(principal, roomId).messages.filter(message => message.sender.type === 'bot').map(message => `${message.sender.name}:${message.text}`);
}
function seedLegacyRoom(f, id, caps) {
  const now = new Date().toISOString();
  const room = { id, title: id, principalId: JSON.stringify(['team', 'owner']), principal, botIds: f.ids, hostBotId: f.ids[0], maxBotTurns: 0, status: 'active', createdAt: now, updatedAt: now, ...caps };
  f.store.db.prepare('INSERT INTO bot_rooms(id,principal_id,data) VALUES(?,?,?)').run(id, room.principalId, JSON.stringify(room));
}
function rawRoom(f, id) {
  return JSON.parse(f.store.db.prepare('SELECT data FROM bot_rooms WHERE id=?').get(id).data);
}
function gate() {
  let open;
  const wait = new Promise(resolve => { open = resolve; });
  return { wait, open };
}

test('a new room has no cost budget and no tool-call limit, and an expensive round is not stopped [AC:room-budgets-default-off#AC-1]', async () => {
  const f = fixture();
  const rooms = new BotRoomService(f.host);
  const room = rooms.create(principal, { title: 'Open', botIds: f.ids });
  assert.equal(room.maxCostUsd, 0);
  assert.equal(room.costCapEnabled, false);
  assert.equal(room.maxToolCalls, 0);
  assert.equal(room.toolCapEnabled, false);
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    f.scripts.set(name, async api => { api.spend(0.9); await api.modelDone(60); api.say(`reply:${name}`); await api.modelDone(0); api.finish(); });
  }
  rooms.send(principal, room.id, { text: 'go', mentions: f.ids });
  await rooms.tick();
  const turn = rooms.turns(principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.toolCalls, 180);
  assert.ok(turn.costUsd > 2.5);
  assert.deepEqual(f.cancelled, []);
  assert.equal(botReplies(f, rooms, room.id).length, 3);
});

test('rooms that still carry the old default budgets are switched off when the new version starts [AC:room-budgets-default-off#AC-2]', () => {
  const f = fixture();
  ensureBotRoomSchema(f.store);
  seedLegacyRoom(f, 'room_flags', { maxToolCalls: 100, toolCapEnabled: true, maxCostUsd: 1, costCapEnabled: true });
  seedLegacyRoom(f, 'room_noflags', { maxToolCalls: 100, maxCostUsd: 1 });
  const rooms = new BotRoomService(f.host);
  for (const id of ['room_flags', 'room_noflags']) {
    const room = rooms.get(principal, id);
    assert.equal(room.costCapEnabled, false, id);
    assert.equal(room.maxCostUsd, 0, id);
    assert.equal(room.toolCapEnabled, false, id);
    assert.equal(room.maxToolCalls, 0, id);
  }
});

test('budgets that differ from the old default stay as they were [AC:room-budgets-default-off#AC-3]', async () => {
  const f = fixture();
  ensureBotRoomSchema(f.store);
  seedLegacyRoom(f, 'room_custom', { maxToolCalls: 30, toolCapEnabled: true, maxCostUsd: 2, costCapEnabled: true });
  seedLegacyRoom(f, 'room_mixed', { maxToolCalls: 30, toolCapEnabled: true, maxCostUsd: 1, costCapEnabled: true });
  seedLegacyRoom(f, 'room_off', { maxToolCalls: 100, toolCapEnabled: false, maxCostUsd: 1, costCapEnabled: false });
  const before = rawRoom(f, 'room_off');
  const rooms = new BotRoomService(f.host);
  const custom = rooms.get(principal, 'room_custom');
  assert.deepEqual([custom.maxToolCalls, custom.toolCapEnabled, custom.maxCostUsd, custom.costCapEnabled], [30, true, 2, true]);
  const mixed = rooms.get(principal, 'room_mixed');
  assert.deepEqual([mixed.maxToolCalls, mixed.toolCapEnabled, mixed.maxCostUsd, mixed.costCapEnabled], [30, true, 0, false]);
  assert.deepEqual(rawRoom(f, 'room_off'), before);
  f.scripts.set('Alpha', async api => { api.spend(2.5); api.say('over'); await api.modelDone(0); api.finish(); });
  rooms.send(principal, 'room_custom', { text: 'go', mentions: [f.ids[0]] });
  await rooms.tick();
  assert.equal(rooms.turns(principal, 'room_custom')[0].terminationReason, 'cost_budget');
});

test('a budget someone turns on after the upgrade survives the next start and is enforced [AC:room-budgets-default-off#AC-4]', async () => {
  const f = fixture();
  ensureBotRoomSchema(f.store);
  seedLegacyRoom(f, 'room_old', { maxToolCalls: 100, toolCapEnabled: true, maxCostUsd: 1, costCapEnabled: true });
  const first = new BotRoomService(f.host);
  assert.equal(first.get(principal, 'room_old').costCapEnabled, false);
  first.patch(principal, 'room_old', { maxCostUsd: 1, costCapEnabled: true, maxToolCalls: 100, toolCapEnabled: true });
  const rooms = new BotRoomService(f.host);
  const room = rooms.get(principal, 'room_old');
  assert.deepEqual([room.maxToolCalls, room.toolCapEnabled, room.maxCostUsd, room.costCapEnabled], [100, true, 1, true]);
  f.scripts.set('Alpha', async api => { api.spend(1.2); await api.modelDone(1); if (!api.cancelledNow()) { api.say('should not be written'); api.finish(); } });
  rooms.send(principal, 'room_old', { text: 'go', mentions: [f.ids[0], f.ids[1]] });
  await rooms.tick();
  const turn = rooms.turns(principal, 'room_old')[0];
  assert.equal(turn.status, 'failed');
  assert.equal(turn.terminationReason, 'cost_budget');
});

test('the saved default budgets for new rooms start at off and apply to rooms created afterwards [AC:room-budgets-default-off#AC-5]', async () => {
  const f = fixture();
  const rooms = new BotRoomService(f.host);
  assert.equal(readRoomSettings(f.store).defaultMaxCostUsd, 0);
  assert.equal(readRoomSettings(f.store).defaultMaxToolCalls, 0);
  assert.throws(() => writeRoomSettings(f.store, { defaultMaxCostUsd: -1 }));
  assert.throws(() => writeRoomSettings(f.store, { defaultMaxCostUsd: 1001 }));
  assert.throws(() => writeRoomSettings(f.store, { defaultMaxToolCalls: 1.5 }));
  const saved = rooms.writeSettings({ defaultMaxCostUsd: 2.5, defaultMaxToolCalls: 40 });
  assert.equal(saved.defaultMaxCostUsd, 2.5);
  assert.equal(saved.defaultMaxToolCalls, 40);
  const room = rooms.create(principal, { title: 'Budgeted', botIds: f.ids });
  assert.deepEqual([room.maxToolCalls, room.toolCapEnabled, room.maxCostUsd, room.costCapEnabled], [40, true, 2.5, true]);
  const explicitOff = rooms.create(principal, { title: 'Explicit off', botIds: f.ids, maxCostUsd: 0, maxToolCalls: 0 });
  assert.deepEqual([explicitOff.toolCapEnabled, explicitOff.costCapEnabled], [false, false]);
  f.scripts.set('Alpha', async api => { await api.modelDone(41); api.finish(); });
  rooms.send(principal, room.id, { text: 'go', mentions: [f.ids[0]] });
  await rooms.tick();
  assert.equal(rooms.turns(principal, room.id)[0].terminationReason, 'tool_budget');
  // A restart keeps the budget this room was created with from the saved default.
  assert.equal(new BotRoomService(f.host).get(principal, room.id).costCapEnabled, true);
});

/** Alpha trips the stop. Beta has written its answer but its run returns later. Gamma is still working. */
function threeWayStop(f, alpha) {
  const late = gate();
  f.scripts.set('Alpha', async api => { await alpha(api); setTimeout(late.open, 20); });
  f.scripts.set('Beta', async api => { api.spend(0.1); api.say('reply:Beta'); await api.modelDone(0); api.finish(); await late.wait; });
  f.scripts.set('Gamma', async api => { api.spend(0.1); await late.wait; if (!api.cancelledNow()) { api.say('reply:Gamma'); api.finish(); } });
}

test('replies already written when the cost budget stops the round still reach the room [AC:room-budgets-default-off#AC-6]', async () => {
  const f = fixture();
  const rooms = new BotRoomService(f.host);
  const room = rooms.create(principal, { title: 'Cost', botIds: f.ids, maxCostUsd: 1 });
  threeWayStop(f, async api => { api.spend(1.2); api.say('reply:Alpha'); await api.modelDone(0); api.finish(); });
  rooms.send(principal, room.id, { text: 'go', mentions: f.ids });
  await rooms.tick();
  const turn = rooms.turns(principal, room.id)[0];
  assert.equal(turn.status, 'failed');
  assert.equal(turn.terminationReason, 'cost_budget');
  assert.deepEqual(botReplies(f, rooms, room.id).sort(), ['Alpha:reply:Alpha', 'Beta:reply:Beta']);
  assert.deepEqual([...turn.postedBotIds].sort(), [f.ids[0], f.ids[1]].sort());
  assert.ok(Math.abs(turn.costUsd - 1.3) < 1e-9, `finished members are both counted, got ${turn.costUsd}`);
});

test('members still working when the cost budget stops the round are cancelled and post nothing [AC:room-budgets-default-off#AC-7]', async () => {
  const f = fixture();
  const rooms = new BotRoomService(f.host);
  const room = rooms.create(principal, { title: 'Cost', botIds: f.ids, maxCostUsd: 1 });
  threeWayStop(f, async api => { api.spend(1.2); api.say('reply:Alpha'); await api.modelDone(0); api.finish(); });
  rooms.send(principal, room.id, { text: 'go', mentions: f.ids });
  await rooms.tick();
  assert.deepEqual(f.cancelled, ['Gamma']);
  const turn = rooms.turns(principal, room.id)[0];
  assert.ok(!botReplies(f, rooms, room.id).some(line => line.startsWith('Gamma:')));
  assert.ok(!(turn.postedBotIds ?? []).includes(f.ids[2]));
  assert.equal(turn.members.find(member => member.botId === f.ids[2]).status, 'failed');
  assert.ok(turn.members.every(member => member.status !== 'running'));
  assert.equal(turn.currentSessionId, undefined);
});

test('the tool-call limit cancels whoever is still working and keeps the reply that was already written [AC:room-budgets-default-off#AC-8]', async () => {
  const f = fixture();
  const rooms = new BotRoomService(f.host);
  const room = rooms.create(principal, { title: 'Tools', botIds: f.ids, maxToolCalls: 1 });
  threeWayStop(f, async api => { await api.modelDone(2); if (!api.cancelledNow()) { api.say('reply:Alpha'); api.finish(); } });
  rooms.send(principal, room.id, { text: 'go', mentions: f.ids });
  await rooms.tick();
  const turn = rooms.turns(principal, room.id)[0];
  assert.equal(turn.status, 'failed');
  assert.equal(turn.terminationReason, 'tool_budget');
  assert.deepEqual([...f.cancelled].sort(), ['Alpha', 'Gamma']);
  assert.deepEqual(botReplies(f, rooms, room.id), ['Beta:reply:Beta']);
  assert.deepEqual(turn.postedBotIds, [f.ids[1]]);
});

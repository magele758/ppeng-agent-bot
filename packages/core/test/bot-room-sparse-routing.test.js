import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { BotFunctionalGroupService } from '../dist/bots/functional-groups.js';
import { ValidationError } from '../dist/errors.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sparse-room-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(name => createBot(facade, { name }));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const runs = [];
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      runs.push(id);
      store.appendMessage(id, 'assistant', [{ type: 'text', text: `reply:${store.getSession(id).agentId}` }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, facade, host, rooms: new BotRoomService(host), bots, runs, principal };
}

test('Lab room settings raise the roster and room caps without a restart [AC:bot-room-sparse-routing#AC-1] [AC:bot-room-sparse-routing#AC-8]', () => {
  const f = fixture();
  assert.equal(f.rooms.readSettings().rosterCap, 50);
  assert.equal(f.rooms.readSettings().maxRoomMembers, 50);
  const room = f.rooms.create(f.principal, { title: 'Kept', botIds: [f.bots[0].id, f.bots[1].id], maxBotTurns: 3 });
  f.rooms.writeSettings({ rosterCap: 4, maxRoomMembers: 2, maxWaveSpeakers: 1 });
  assert.throws(() => createBot(f.facade, { name: 'Sixth' }), /roster cap reached \(4\)/);
  assert.equal(f.store.listBots().some(bot => bot.name === 'Alpha'), true);
  f.rooms.writeSettings({ rosterCap: 5 });
  assert.equal(createBot(f.facade, { name: 'Sixth' }).name, 'Sixth');
  assert.throws(() => f.rooms.addMember(f.principal, room.id, f.bots[2].id), /Room member limit is 2/);
  assert.deepEqual(f.rooms.get(f.principal, room.id).botIds, [f.bots[0].id, f.bots[1].id]);
  f.rooms.writeSettings({ maxRoomMembers: 3 });
  assert.deepEqual(f.rooms.addMember(f.principal, room.id, f.bots[2].id).botIds, [f.bots[0].id, f.bots[1].id, f.bots[2].id]);
  f.rooms.writeSettings({ maxRoomMembers: 80 });
  assert.equal(f.rooms.get(f.principal, room.id).maxBotTurns, 3);
  assert.throws(() => f.rooms.writeSettings({ approvalMode: 'in_room' }), ValidationError);
});

test('an authorized functional group joins and an unauthorized bot is skipped with a reason [AC:bot-room-sparse-routing#AC-1]', () => {
  const f = fixture();
  const outsider = createBot(f.facade, { name: 'Outsider' });
  f.store.updateSession(outsider.canonicalSessionId, { metadata: { ...f.store.getSession(outsider.canonicalSessionId).metadata, ...f.principal } });
  const groups = new BotFunctionalGroupService(f.store);
  const group = groups.create(f.principal, 'Desk');
  groups.move(f.principal, f.bots[2].id, group.id);
  groups.move(f.principal, outsider.id, group.id);
  f.store.updateSession(outsider.canonicalSessionId, { metadata: { ...f.store.getSession(outsider.canonicalSessionId).metadata, userId: 'intruder', tenantId: 'other' } });
  const room = f.rooms.create(f.principal, { title: 'Desk', botIds: [f.bots[0].id, f.bots[1].id] });
  const added = f.rooms.addGroup(f.principal, room.id, group.id);
  assert.ok(added.room.botIds.includes(f.bots[2].id));
  assert.ok(!added.room.botIds.includes(outsider.id));
  assert.equal(added.skipped.length, 1);
  assert.equal(added.skipped[0].botId, outsider.id);
  assert.match(added.skipped[0].reason, /无权/);
  f.rooms.writeSettings({ maxRoomMembers: 3 });
  const full = f.rooms.create(f.principal, { title: 'Full', botIds: [f.bots[0].id, f.bots[1].id, f.bots[2].id] });
  const overflow = groups.create(f.principal, 'More');
  groups.move(f.principal, f.bots[3].id, overflow.id);
  assert.throws(() => f.rooms.addGroup(f.principal, full.id, overflow.id), /Room member limit is 3/);
  assert.deepEqual(f.rooms.get(f.principal, full.id).botIds, [f.bots[0].id, f.bots[1].id, f.bots[2].id]);
});

test('an @ wakes only named members inside the cap, and silence does not summon anyone else [AC:bot-room-sparse-routing#AC-2] [AC:bot-room-sparse-routing#AC-6] [AC:bot-room-speaker-pick#AC-6] [AC:bot-room-speaker-pick#AC-7]', async () => {
  const f = fixture();
  f.rooms.writeSettings({ maxWaveSpeakers: 2 });
  const room = f.rooms.create(f.principal, { title: 'Named', botIds: f.bots.slice(0, 3).map(bot => bot.id), hostBotId: f.bots[0].id, maxBotTurns: 1 });
  f.host.runSession = async id => {
    f.runs.push(id);
    const agentId = f.store.getSession(id).agentId;
    const text = agentId === f.bots[0].id ? '[SILENT]' : `reply:${agentId}`;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: `go @${f.bots[0].name} @${f.bots[1].name} @${f.bots[2].name}` });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.deepEqual(turn.botIds, [f.bots[0].id, f.bots[1].id]);
  assert.deepEqual(f.runs.map(id => f.store.getSession(id).agentId), [f.bots[0].id, f.bots[1].id]);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.deepEqual(posted.map(message => message.sender.id), [f.bots[1].id]);
  assert.equal(turn.botTurns, 1);
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.terminationReason, 'failed');
});

test('an unknown @ posts a not-found notice and does not wake the room [AC:bot-room-sparse-routing#AC-3] [AC:bot-rooms#AC-2] [AC:bot-room-speaker-pick#AC-7]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Missing', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
  const sent = f.rooms.send(f.principal, room.id, { text: '@NoSuchMember hello' });
  assert.deepEqual(sent.turn.botIds, []);
  await f.rooms.tick();
  assert.equal(f.runs.length, 0);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /没有找到/);
  assert.equal(posted[0].sender.id, f.bots[0].id);
});

test('an unnamed message that matches nobody wakes nobody [AC:bot-room-sparse-routing#AC-4] [AC:bot-room-speaker-pick#AC-5]', async () => {
  const f = fixture();
  const ids = f.bots.slice(0, 3).map(bot => bot.id);
  f.rooms.writeSettings({ maxWaveSpeakers: 2 });
  const room = f.rooms.create(f.principal, { title: 'Open', botIds: ids, hostBotId: f.bots[0].id });
  const sent = f.rooms.send(f.principal, room.id, { text: 'ordinary question' });
  assert.deepEqual(sent.turn.botIds, []);
  assert.equal(sent.turn.mentionedBotIds, undefined);
  await f.rooms.tick();
  assert.equal(f.runs.length, 0);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.some(message => message.sender.type === 'bot'), false);
});

test('a 2-person unnamed turn that matches nobody posts nothing [AC:bot-room-sparse-routing#AC-5] [AC:bot-room-speaker-pick#AC-5]', async () => {
  const f = fixture();
  const room = f.rooms.create(f.principal, { title: 'Small', botIds: [f.bots[0].id, f.bots[1].id], hostBotId: f.bots[0].id });
  f.rooms.send(f.principal, room.id, { text: 'anyone there?' });
  await f.rooms.tick();
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.status, 'failed');
  assert.equal(f.runs.length, 0);
  const posted = f.rooms.messages(f.principal, room.id).messages.filter(message => message.sender.type === 'bot');
  assert.equal(posted.length, 0);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.some(message => message.text.includes('我先接住')), false);
});

test('rooms cannot be created or reduced below two members, and a member is not duplicated [AC:bot-room-sparse-routing#AC-7]', () => {
  const f = fixture();
  assert.throws(() => f.rooms.create(f.principal, { title: 'Solo', botIds: [f.bots[0].id] }), /at least 2/);
  assert.throws(() => f.rooms.create(f.principal, { title: 'Dup', botIds: [f.bots[0].id, f.bots[0].id] }), /at least 2/);
  const room = f.rooms.create(f.principal, { title: 'Pair', botIds: [f.bots[0].id, f.bots[1].id] });
  assert.deepEqual(f.rooms.addMember(f.principal, room.id, f.bots[0].id).botIds, [f.bots[0].id, f.bots[1].id]);
  assert.throws(() => f.rooms.removeMember(f.principal, room.id, f.bots[1].id), /at least 2/);
  assert.deepEqual(f.rooms.get(f.principal, room.id).botIds, [f.bots[0].id, f.bots[1].id]);
});

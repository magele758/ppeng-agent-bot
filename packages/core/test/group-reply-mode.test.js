import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';

function fixture(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'reply-mode-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = specs.map(spec => createBot(facade, spec));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const runs = [];
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      const agentId = store.getSession(id).agentId;
      runs.push(agentId);
      const bot = bots.find(item => item.id === agentId);
      store.appendMessage(id, 'assistant', [{ type: 'text', text: `各自回复:${bot?.name ?? agentId}` }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, host, rooms: new BotRoomService(host), bots, runs, principal };
}

function botPosts(rooms, principal, roomId) {
  return rooms.messages(principal, roomId).messages.filter(message => message.sender.type === 'bot');
}

test('unnamed coordinator messages stay on the single coordinated path [AC:group-reply-mode#AC-1]', async () => {
  const f = fixture([
    { name: '群主甲', title: '群主甲' },
    { name: '证书甲', title: '证书管理员', description: '负责集群证书续期' },
    { name: '闲聊乙', title: '闲聊乙' }
  ]);
  const [hostBot, expert, idle] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Coord', botIds: [hostBot.id, expert.id, idle.id], hostBotId: hostBot.id });
  assert.equal(room.replyMode, 'coordinator');
  assert.equal(f.rooms.get(f.principal, room.id).replyMode, 'coordinator');

  const generic = f.rooms.send(f.principal, room.id, { text: '今天吃什么' });
  assert.equal(generic.turn.replyMode, undefined);
  assert.deepEqual(generic.turn.botIds, []);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f.rooms, f.principal, room.id), []);

  const matched = f.rooms.send(f.principal, room.id, { text: '证书怎么续期' });
  assert.deepEqual(matched.turn.botIds, [expert.id]);
  assert.ok(!matched.turn.botIds.includes(idle.id));
  assert.ok(!matched.turn.botIds.includes(hostBot.id));
  await f.rooms.tick();
  const senders = botPosts(f.rooms, f.principal, room.id).map(message => message.sender.id);
  assert.ok(senders.includes(expert.id));
  assert.ok(!senders.includes(idle.id));
  assert.notEqual(new Set(senders).size, f.bots.length);
});

test('all members each post their own reply and one failure stays on that member [AC:group-reply-mode#AC-2]', async () => {
  const f = fixture([
    { name: 'Super Bot', title: 'Super Bot' },
    { name: 'Alpha', title: 'Alpha' },
    { name: 'Beta', title: 'Beta' }
  ]);
  const [hostBot, alpha, beta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Everyone', botIds: [hostBot.id, alpha.id, beta.id], hostBotId: hostBot.id });
  assert.equal(f.rooms.patch(f.principal, room.id, { replyMode: 'all-members' }).replyMode, 'all-members');
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    if (agentId === beta.id) {
      f.store.updateSession(id, { status: 'failed' });
      return;
    }
    const bot = f.bots.find(item => item.id === agentId);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `各自回复:${bot.name}` }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  const sent = f.rooms.send(f.principal, room.id, { text: '今天吃什么' });
  assert.deepEqual(sent.turn.botIds, [hostBot.id, alpha.id, beta.id]);
  assert.equal(sent.turn.mentionedBotIds, undefined);
  await f.rooms.tick();
  const posts = botPosts(f.rooms, f.principal, room.id);
  const bySender = new Map(posts.map(message => [message.sender.id, message]));
  assert.equal(posts.length, 3);
  assert.equal(bySender.get(hostBot.id)?.text, '各自回复:Super Bot');
  assert.equal(bySender.get(alpha.id)?.text, '各自回复:Alpha');
  assert.equal(bySender.get(beta.id)?.sender.id, beta.id);
  assert.match(bySender.get(beta.id)?.text ?? '', /回复失败/);
  assert.ok(!bySender.get(hostBot.id)?.text.includes('Alpha'));
  assert.ok(!bySender.get(hostBot.id)?.text.includes('回复失败'));
  const turn = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.status, 'failed');
  assert.equal(turn.members.find(member => member.botId === beta.id)?.status, 'failed');
  assert.ok(f.runs.includes(hostBot.id));
  assert.ok(f.runs.includes(alpha.id));
  assert.ok(f.runs.includes(beta.id));
});

test('an @ mention still limits who replies in both modes [AC:group-reply-mode#AC-3]', async () => {
  const f = fixture([
    { name: 'Super Bot', title: 'Super Bot' },
    { name: 'Alpha', title: 'Alpha' },
    { name: 'Beta', title: 'Beta' }
  ]);
  const [hostBot, alpha, beta] = f.bots;
  const coordinator = f.rooms.create(f.principal, { title: 'Named coord', botIds: [hostBot.id, alpha.id, beta.id], hostBotId: hostBot.id });
  const named = f.rooms.send(f.principal, coordinator.id, { text: '只问 @Alpha' });
  assert.deepEqual(named.turn.botIds, [alpha.id]);
  assert.deepEqual(named.turn.mentionedBotIds, [alpha.id]);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f.rooms, f.principal, coordinator.id).map(message => message.sender.id), [alpha.id]);

  const everyone = f.rooms.create(f.principal, { title: 'Named all', botIds: [hostBot.id, alpha.id, beta.id], hostBotId: hostBot.id });
  assert.equal(f.rooms.patch(f.principal, everyone.id, { replyMode: 'all-members' }).replyMode, 'all-members');
  f.runs.length = 0;
  const limited = f.rooms.send(f.principal, everyone.id, { text: '只问 @Beta' });
  assert.deepEqual(limited.turn.botIds, [beta.id]);
  assert.deepEqual(limited.turn.mentionedBotIds, [beta.id]);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f.rooms, f.principal, everyone.id).map(message => message.sender.id), [beta.id]);
  assert.deepEqual(f.runs, [beta.id]);
});

test('reply mode is stored on the room and survives reload without reading env [AC:group-reply-mode#AC-4]', () => {
  const f = fixture([
    { name: 'Super Bot', title: 'Super Bot' },
    { name: 'Alpha', title: 'Alpha' }
  ]);
  const [hostBot, alpha] = f.bots;
  const chosen = f.rooms.create(f.principal, { title: 'Chosen', botIds: [hostBot.id, alpha.id], hostBotId: hostBot.id });
  const other = f.rooms.create(f.principal, { title: 'Other', botIds: [hostBot.id, alpha.id], hostBotId: hostBot.id });
  f.rooms.patch(f.principal, chosen.id, { replyMode: 'all-members' });
  const previous = {
    RAW_AGENT_ROOM_REPLY_MODE: process.env.RAW_AGENT_ROOM_REPLY_MODE,
    RAW_AGENT_REPLY_MODE: process.env.RAW_AGENT_REPLY_MODE,
    RAW_AGENT_GROUP_REPLY_MODE: process.env.RAW_AGENT_GROUP_REPLY_MODE
  };
  process.env.RAW_AGENT_ROOM_REPLY_MODE = 'all-members';
  process.env.RAW_AGENT_REPLY_MODE = 'all-members';
  process.env.RAW_AGENT_GROUP_REPLY_MODE = 'coordinator';
  try {
    const reopened = new BotRoomService(f.host);
    assert.equal(reopened.get(f.principal, chosen.id).replyMode, 'all-members');
    assert.equal(reopened.get(f.principal, other.id).replyMode, 'coordinator');
    const fresh = reopened.create(f.principal, { title: 'Fresh', botIds: [hostBot.id, alpha.id], hostBotId: hostBot.id });
    assert.equal(fresh.replyMode, 'coordinator');
    assert.equal(reopened.get(f.principal, fresh.id).replyMode, 'coordinator');
    assert.throws(() => reopened.writeSettings({ replyMode: 'all-members' }), /replyMode|Unknown room setting/);
    assert.equal(reopened.get(f.principal, other.id).replyMode, 'coordinator');
    assert.equal(reopened.get(f.principal, chosen.id).replyMode, 'all-members');
    const fanOut = reopened.send(f.principal, chosen.id, { text: '今天吃什么' });
    assert.deepEqual(fanOut.turn.botIds, [hostBot.id, alpha.id]);
    const sparse = reopened.send(f.principal, other.id, { text: '今天吃什么' });
    assert.deepEqual(sparse.turn.botIds, []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('failed member errors do not expose private diagnostics in group messages [AC:group-reply-mode#AC-2]', async () => {
  const f = fixture([{ name: 'One', title: 'One' }, { name: 'Two', title: 'Two' }]);
  const room = f.rooms.create(f.principal, { title: 'Private errors', botIds: f.bots.map(bot => bot.id) });
  f.rooms.patch(f.principal, room.id, { replyMode: 'all-members' });
  f.host.runSession = async () => { throw new Error('private-test-token-do-not-publish'); };
  f.rooms.send(f.principal, room.id, { text: 'Reply please' });
  await f.rooms.tick();
  const posts = botPosts(f.rooms, f.principal, room.id);
  assert.equal(posts.length, 2);
  assert.ok(posts.every(post => !post.text.includes('private-test-token')));
});

test('all-members silence leaves a visible failure for that member [AC:group-reply-mode#AC-2]', async () => {
  const f = fixture([{ name: 'One', title: 'One' }, { name: 'Two', title: 'Two' }]);
  const room = f.rooms.create(f.principal, { title: 'No missing speakers', botIds: f.bots.map(bot => bot.id) });
  f.rooms.patch(f.principal, room.id, { replyMode: 'all-members' });
  f.host.runSession = async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '[SILENT]' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'Reply please' });
  await f.rooms.tick();
  assert.equal(botPosts(f.rooms, f.principal, room.id).length, 2);
});

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
  const dir = mkdtempSync(join(tmpdir(), 'speaker-room-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = specs.map(spec => createBot(facade, spec));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const runs = [];
  const prompts = [];
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      runs.push(store.getSession(id).agentId);
      const text = prompts.length >= 0 ? `reply:${store.getSession(id).agentId}` : '';
      store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, host, rooms: new BotRoomService(host), bots, runs, prompts, principal };
}

function botPosts(rooms, principal, roomId) {
  return rooms.messages(principal, roomId).messages.filter(message => message.sender.type === 'bot');
}

function userPrompt(store, sessionId) {
  return store.listMessages(sessionId).filter(message => message.role === 'user').flatMap(message => message.parts).map(part => part.text ?? '').join('\n');
}

test('an unmatched member stays quiet and the matching member answers first [AC:bot-room-speaker-pick#AC-1] [AC:bot-room-sparse-routing#AC-4]', async () => {
  const f = fixture([
    { name: '群主甲', title: '群主甲' },
    { name: '证书甲', title: '证书管理员', description: '负责集群证书续期' },
    { name: '闲聊乙', title: '闲聊乙' }
  ]);
  const [hostBot, expert, idle] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Certs', botIds: [hostBot.id, expert.id, idle.id], hostBotId: hostBot.id });
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    f.prompts.push(userPrompt(f.store, id));
    const text = agentId === hostBot.id ? '[SILENT]' : '证书要在到期前轮换';
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  const sent = f.rooms.send(f.principal, room.id, { text: '证书怎么续期' });
  assert.deepEqual(sent.turn.botIds, [expert.id]);
  await f.rooms.tick();
  assert.equal(f.runs[0], expert.id);
  assert.ok(!f.runs.includes(idle.id));
  const posted = botPosts(f.rooms, f.principal, room.id);
  assert.deepEqual(posted.map(message => message.sender.id), [expert.id]);
  assert.equal(posted.some(message => message.text.includes('我先接住')), false);
});

test('matching members answer together up to the cap and the host joins only when they match [AC:bot-room-speaker-pick#AC-2]', async () => {
  const f = fixture([
    { name: '群主甲', title: '证书值班' },
    { name: '手册乙', title: '手册乙', description: '证书续期手册' },
    { name: '值班丙', title: '证书管理员' },
    { name: '闲聊丁', title: '闲聊丁' }
  ]);
  const [hostBot, manual, duty, idle] = f.bots;
  f.rooms.writeSettings({ maxWaveSpeakers: 2 });
  const room = f.rooms.create(f.principal, { title: 'Cap', botIds: f.bots.map(bot => bot.id), hostBotId: hostBot.id });
  let active = 0;
  let peak = 0;
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `答:${agentId}` }]);
    f.store.updateSession(id, { status: 'idle' });
    active -= 1;
  };
  const sent = f.rooms.send(f.principal, room.id, { text: '证书续期' });
  assert.equal(sent.turn.botIds.length, 2);
  assert.ok(sent.turn.botIds.includes(manual.id));
  assert.ok(sent.turn.botIds.includes(hostBot.id));
  assert.ok(!sent.turn.botIds.includes(duty.id));
  assert.ok(!sent.turn.botIds.includes(idle.id));
  await f.rooms.tick();
  assert.ok(peak >= 2);
  assert.ok(f.runs.includes(manual.id));
  assert.ok(f.runs.includes(hostBot.id));
  assert.ok(!f.runs.includes(duty.id));
  assert.ok(!f.runs.includes(idle.id));
});

test('the host may add one short close after an expert, and a refusal stays out [AC:bot-room-speaker-pick#AC-3]', async () => {
  const specs = [
    { name: '群主甲', title: '群主甲' },
    { name: '证书甲', title: '证书管理员', description: '负责集群证书续期' },
    { name: '闲聊乙', title: '闲聊乙' }
  ];
  const spoken = fixture(specs);
  const [hostBot, expert, idle] = spoken.bots;
  const room = spoken.rooms.create(spoken.principal, { title: 'Close', botIds: [hostBot.id, expert.id, idle.id], hostBotId: hostBot.id });
  spoken.host.runSession = async id => {
    const agentId = spoken.store.getSession(id).agentId;
    spoken.runs.push(agentId);
    spoken.prompts.push(userPrompt(spoken.store, id));
    const text = agentId === hostBot.id ? '补一句：到期前轮换' : '先核对吊销列表';
    spoken.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    spoken.store.updateSession(id, { status: 'idle' });
  };
  spoken.rooms.send(spoken.principal, room.id, { text: '证书怎么续期' });
  await spoken.rooms.tick();
  assert.deepEqual(spoken.runs, [expert.id, hostBot.id]);
  assert.ok(!spoken.runs.includes(idle.id));
  assert.match(spoken.prompts[1], /closing summary/);
  const posted = botPosts(spoken.rooms, spoken.principal, room.id).map(message => message.text);
  assert.deepEqual(posted, ['先核对吊销列表', '补一句：到期前轮换']);

  const quiet = fixture(specs);
  const [quietHost, quietExpert, quietIdle] = quiet.bots;
  const quietRoom = quiet.rooms.create(quiet.principal, { title: 'No close', botIds: [quietHost.id, quietExpert.id, quietIdle.id], hostBotId: quietHost.id });
  quiet.host.runSession = async id => {
    const agentId = quiet.store.getSession(id).agentId;
    quiet.runs.push(agentId);
    const text = agentId === quietHost.id ? '没有要补充' : '先核对吊销列表';
    quiet.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    quiet.store.updateSession(id, { status: 'idle' });
  };
  quiet.rooms.send(quiet.principal, quietRoom.id, { text: '证书怎么续期' });
  await quiet.rooms.tick();
  assert.deepEqual(quiet.runs, [quietExpert.id, quietHost.id]);
  assert.ok(!quiet.runs.includes(quietIdle.id));
  const quietPosts = botPosts(quiet.rooms, quiet.principal, quietRoom.id);
  assert.deepEqual(quietPosts.map(message => message.text), ['先核对吊销列表']);
  assert.equal(quiet.rooms.turns(quiet.principal, quietRoom.id)[0].botTurns, 1);
});

test('after the host posts, one clearly closer member may add a correction and a second extra member stays quiet [AC:bot-room-speaker-pick#AC-4]', async () => {
  const f = fixture([
    { name: '群主甲', title: '群主甲' },
    { name: '专家甲', title: '证书续期专家' },
    { name: '值班乙', title: '证书值班' },
    { name: '闲聊丙', title: '闲聊丙' }
  ]);
  const [hostBot, expert, next, idle] = f.bots;
  f.rooms.writeSettings({ maxWaveSpeakers: 1 });
  const room = f.rooms.create(f.principal, { title: 'One more', botIds: f.bots.map(bot => bot.id), hostBotId: hostBot.id, maxBotTurns: 8 });
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    f.prompts.push({ agentId, text: userPrompt(f.store, id) });
    const text = agentId === expert.id ? '证书要在到期前轮换' : agentId === hostBot.id ? '我先记下这点' : agentId === next.id ? '补充：还要核对吊销列表' : '不该出现';
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  const sent = f.rooms.send(f.principal, room.id, { text: '证书续期' });
  assert.deepEqual(sent.turn.botIds, [expert.id]);
  await f.rooms.tick();
  assert.deepEqual(f.runs, [expert.id, hostBot.id, next.id]);
  assert.ok(!f.runs.includes(idle.id));
  const follow = f.prompts.find(item => item.agentId === next.id);
  assert.match(follow.text, /证书要在到期前轮换/);
  assert.match(follow.text, /Add a correction/);
  const posted = botPosts(f.rooms, f.principal, room.id).map(message => message.text);
  assert.deepEqual(posted, ['证书要在到期前轮换', '我先记下这点', '补充：还要核对吊销列表']);
});

test('nobody above the line leaves the room with no reply and no catch-all [AC:bot-room-speaker-pick#AC-5] [AC:bot-room-sparse-routing#AC-5] [AC:bot-rooms#AC-2]', async () => {
  const f = fixture([
    { name: '群主甲', title: '群主甲' },
    { name: '闲聊乙', title: '闲聊乙' },
    { name: '闲聊丙', title: '闲聊丙' }
  ]);
  const room = f.rooms.create(f.principal, { title: 'Quiet', botIds: f.bots.map(bot => bot.id), hostBotId: f.bots[0].id });
  f.rooms.send(f.principal, room.id, { text: '今天天气怎么样' });
  await f.rooms.tick();
  assert.equal(f.runs.length, 0);
  const posted = botPosts(f.rooms, f.principal, room.id);
  assert.equal(posted.length, 0);
  assert.equal(f.rooms.messages(f.principal, room.id).messages.some(message => message.text.includes('我先接住')), false);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'completed');
});

test('a short refusal does not enter the room or use a speaking slot [AC:bot-room-speaker-pick#AC-6] [AC:bot-rooms#AC-2]', async () => {
  const f = fixture([
    { name: '手册乙', title: '手册乙', description: '证书续期手册' },
    { name: '证书甲', title: '证书管理员' }
  ]);
  const [first, second] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Refuse', botIds: [first.id, second.id], hostBotId: first.id, maxBotTurns: 4 });
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    const text = agentId === first.id ? '我不知道' : '证书要在到期前轮换';
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: '证书续期' });
  await f.rooms.tick();
  assert.ok(f.runs.includes(first.id));
  assert.ok(f.runs.includes(second.id));
  const posted = botPosts(f.rooms, f.principal, room.id);
  assert.deepEqual(posted.map(message => message.text), ['证书要在到期前轮换']);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].botTurns, 1);
});

test('quoting a bot reply wakes only that bot [AC:bot-room-speaker-pick#AC-8]', async () => {
  const f = fixture([
    { name: '证书甲', title: '证书管理员', description: '负责集群证书续期' },
    { name: '闲聊乙', title: '闲聊乙' }
  ]);
  const [expert, other] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Quote', botIds: [expert.id, other.id], hostBotId: other.id });
  f.rooms.send(f.principal, room.id, { text: `hi @${other.name}` });
  await f.rooms.tick();
  const quoted = botPosts(f.rooms, f.principal, room.id)[0];
  f.runs.length = 0;
  const sent = f.rooms.send(f.principal, room.id, {
    text: '证书怎么续期',
    replyTo: { messageId: quoted.id, excerpt: 'reply' }
  });
  assert.deepEqual(sent.turn.botIds, [other.id]);
  await f.rooms.tick();
  assert.deepEqual(f.runs, [other.id]);
});

test('the host is the member chosen at creation, and the first member is host only when nobody was chosen [AC:bot-room-speaker-pick#AC-9]', async () => {
  const f = fixture([
    { name: '名单第一', title: '名单第一' },
    { name: '指定群主', title: '指定群主' },
    { name: '证书甲', title: '证书管理员', description: '负责集群证书续期' }
  ]);
  const [first, chosen, expert] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Host', botIds: [first.id, chosen.id, expert.id], hostBotId: chosen.id });
  assert.equal(room.hostBotId, chosen.id);
  f.host.runSession = async id => {
    f.runs.push(f.store.getSession(id).agentId);
    const text = f.store.getSession(id).agentId === chosen.id ? '[SILENT]' : '证书要在到期前轮换';
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  const sent = f.rooms.send(f.principal, room.id, { text: '证书怎么续期' });
  assert.deepEqual(sent.turn.botIds, [expert.id]);
  await f.rooms.tick();
  assert.equal(f.runs[0], expert.id);
  assert.ok(!f.runs.includes(first.id));
  const posted = botPosts(f.rooms, f.principal, room.id);
  assert.deepEqual(posted.map(message => message.sender.id), [expert.id]);
  const unnamedHost = f.rooms.create(f.principal, { title: 'Default host', botIds: [chosen.id, first.id] });
  assert.equal(unnamedHost.hostBotId, chosen.id);
});

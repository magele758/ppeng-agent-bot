import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { rateLimitDecision } from '../dist/rooms/anti-storm.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wave-room-'));
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

function botPosts(rooms, principal, roomId) {
  return rooms.messages(principal, roomId).messages.filter(message => message.sender.type === 'bot');
}

function replyKeys(store, roomId) {
  return store.db.prepare("SELECT idem_key FROM bot_room_messages WHERE room_id=? AND idem_key LIKE 'reply:%'").all(roomId).map(row => row.idem_key);
}

test('selected members appear in completion order and a large unnamed room stays sparse [AC:bot-room-wave-dispatch#AC-1] [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const [alpha, beta, gamma, delta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Wave', botIds: f.bots.map(bot => bot.id), hostBotId: alpha.id, maxBotTurns: 8 });
  let active = 0;
  let peak = 0;
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, agentId === beta.id ? 10 : 40));
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `done:${agentId}` }]);
    f.store.updateSession(id, { status: 'idle' });
    active -= 1;
  };
  f.rooms.send(f.principal, room.id, { text: 'both', mentions: [alpha.id, beta.id] });
  await f.rooms.tick();
  assert.ok(peak >= 2);
  const posted = botPosts(f.rooms, f.principal, room.id);
  assert.deepEqual(posted.map(message => message.sender.id), [beta.id, alpha.id]);
  assert.ok(replyKeys(f.store, room.id).every(key => key.includes(alpha.id) || key.includes(beta.id)));
  f.runs.length = 0;
  f.rooms.send(f.principal, room.id, { text: 'unnamed large room' });
  await f.rooms.tick();
  assert.deepEqual(f.runs, []);
  assert.ok(!f.runs.includes(gamma.id) && !f.runs.includes(delta.id));
});

test('a member posts once, and the host may summarize after the others [AC:bot-room-wave-dispatch#AC-2] [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Once', botIds: [alpha.id, beta.id], hostBotId: alpha.id, maxBotTurns: 8 });
  const sent = f.rooms.send(f.principal, room.id, { text: 'again', mentions: [alpha.id, beta.id] });
  const stored = f.rooms.turns(f.principal, room.id)[0];
  stored.botIds = [alpha.id, beta.id, alpha.id];
  f.store.db.prepare('UPDATE bot_room_turns SET data=? WHERE id=?').run(JSON.stringify(stored), sent.turn.id);
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `said:${agentId}:${f.runs.length}` }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  await f.rooms.tick();
  const first = botPosts(f.rooms, f.principal, room.id);
  assert.equal(first.filter(message => message.sender.id === alpha.id).length, 1);
  assert.equal(first.filter(message => message.sender.id === beta.id).length, 1);

  f.runs.length = 0;
  let hostPasses = 0;
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    if (agentId === alpha.id && hostPasses === 0) {
      hostPasses += 1;
      f.rooms.routeTurn(id, [beta.id], { summarize: true });
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'opening' }]);
    } else if (agentId === alpha.id) {
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'closing summary' }]);
    } else {
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta point' }]);
    }
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'ordinary', mentions: [alpha.id] });
  await f.rooms.tick();
  const second = botPosts(f.rooms, f.principal, room.id).slice(first.length);
  assert.equal(second.filter(message => message.text === 'opening').length, 1);
  assert.equal(second.filter(message => message.text === 'beta point').length, 1);
  assert.equal(second.filter(message => message.text === 'closing summary').length, 1);
  assert.equal(f.runs.filter(id => id === beta.id).length, 1);
});

test('stopping the room drops replies that have not appeared, and unconfirmed work stays unchecked [AC:bot-room-wave-dispatch#AC-3] [AC:bot-rooms#AC-2]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Stop', botIds: [alpha.id, beta.id], hostBotId: alpha.id, maxBotTurns: 8 });
  const started = [];
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  f.host.runSession = async id => {
    started.push(id);
    await gate;
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'late reply' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'go', mentions: [alpha.id, beta.id] });
  const pending = f.rooms.tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(started.length, 2);
  f.rooms.stop(f.principal, room.id);
  release();
  await pending;
  assert.equal(botPosts(f.rooms, f.principal, room.id).length, 0);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'cancelled');

  f.host.hasUnconfirmedEffects = () => true;
  f.host.runSession = async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'unchecked side effect' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  const resumed = f.rooms.resume(f.principal, room.id);
  assert.equal(resumed.status, 'active');
  f.rooms.send(f.principal, room.id, { text: 'effect', mentions: [alpha.id, beta.id] });
  await f.rooms.tick();
  const effect = f.rooms.turns(f.principal, room.id).at(-1);
  assert.equal(effect.status, 'unknown');
  assert.equal(effect.terminationReason, 'external_effect_unconfirmed');
  assert.equal(botPosts(f.rooms, f.principal, room.id).some(message => message.text.includes('unchecked')), false);
});

test('one member failing or leaving for private chat does not drop the other replies [AC:bot-room-wave-dispatch#AC-4]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Partial', botIds: [alpha.id, beta.id], hostBotId: alpha.id, maxBotTurns: 8 });
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    if (agentId === alpha.id) {
      f.store.updateSession(id, { status: 'failed' });
      return;
    }
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta stays' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'go', mentions: [alpha.id, beta.id] });
  await f.rooms.tick();
  const failed = f.rooms.turns(f.principal, room.id)[0];
  assert.notEqual(failed.status, 'failed');
  assert.equal(botPosts(f.rooms, f.principal, room.id).some(message => message.text === 'beta stays'), true);

  f.host.runSession = async id => {
    const session = f.store.getSession(id);
    if (session.agentId === alpha.id) {
      f.store.appendMessage(id, 'assistant', [{ type: 'tool_call', toolCallId: 'room-call', name: 'write_file', input: { path: 'out.txt' } }]);
      f.store.createApproval({ sessionId: id, toolName: 'write_file', reason: 'needs a person', args: { path: 'out.txt' } });
      f.store.updateSession(id, { status: 'waiting_approval', metadata: { ...session.metadata, interrupt: { kind: 'waiting_approval' }, outcome: { kind: 'waiting_approval' } } });
      return;
    }
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: 'beta during handoff' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'approve', mentions: [alpha.id, beta.id] });
  await f.rooms.tick();
  const handed = f.rooms.turns(f.principal, room.id).at(-1);
  assert.notEqual(handed.status, 'failed');
  const texts = botPosts(f.rooms, f.principal, room.id).map(message => message.text);
  assert.ok(texts.includes('beta during handoff'));
  assert.ok(texts.some(text => text.includes('私聊')));
  assert.equal(handed.members?.find(member => member.botId === alpha.id)?.status, 'handed_off');
  assert.notEqual(handed.status, 'waiting_approval');
});

test('a host list drops outsiders and anyone past the cap, and says why [AC:bot-room-wave-dispatch#AC-5]', async () => {
  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  f.rooms.writeSettings({ maxWaveSpeakers: 2 });
  const room = f.rooms.create(f.principal, { title: 'Drop', botIds: [alpha.id, beta.id, gamma.id], hostBotId: alpha.id, maxBotTurns: 8 });
  f.host.runSession = async id => {
    const agentId = f.store.getSession(id).agentId;
    f.runs.push(agentId);
    if (agentId === alpha.id) f.rooms.routeTurn(id, ['not-a-member', beta.id, gamma.id]);
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `reply:${agentId}` }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'choose', mentions: [alpha.id] });
  await f.rooms.tick();
  assert.deepEqual(f.runs, [alpha.id, beta.id]);
  const notice = botPosts(f.rooms, f.principal, room.id).map(message => message.text).join('\n');
  assert.match(notice, /不是群成员/);
  assert.match(notice, /not-a-member/);
  assert.match(notice, /超过本轮人数/);
  assert.match(notice, new RegExp(gamma.id));
});

test('a saved per-minute reply cap pauses further speakers and still accepts messages [AC:bot-room-wave-dispatch#AC-6]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  f.rooms.writeSettings({ maxRepliesPerMinute: 1 });
  const room = f.rooms.create(f.principal, { title: 'Storm', botIds: [alpha.id, beta.id], hostBotId: alpha.id, maxBotTurns: 8 });
  f.rooms.send(f.principal, room.id, { text: 'burst', mentions: [alpha.id, beta.id] });
  await f.rooms.tick();
  assert.deepEqual(f.runs.map(id => f.store.getSession(id).agentId), [alpha.id]);
  const notice = botPosts(f.rooms, f.principal, room.id).map(message => message.text).join('\n');
  assert.match(notice, /每分钟/);
  assert.match(notice, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.rooms.get(f.principal, room.id).status, 'active');
  const extra = f.rooms.send(f.principal, room.id, { text: 'still accepted' });
  assert.equal(extra.message.text, 'still accepted');
  await f.rooms.tick();
  assert.equal(f.runs.length, 1);
  const later = rateLimitDecision(['2000-01-01T00:00:00.000Z'], 1, Date.parse('2026-10-21T00:00:00.000Z'), 0);
  assert.equal(later.allow, true);
});

test('a short substantive reply is still posted [AC:bot-room-wave-dispatch#AC-7]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Short', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
  f.host.runSession = async id => {
    f.store.appendMessage(id, 'assistant', [{ type: 'text', text: '是' }]);
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, room.id, { text: 'yes?', mentions: [alpha.id] });
  await f.rooms.tick();
  assert.equal(botPosts(f.rooms, f.principal, room.id).some(message => message.text === '是'), true);
});

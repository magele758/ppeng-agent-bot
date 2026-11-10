import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';
import { resolveDebatePlan, debateSpeechAt, debateFullTextBlock, DEBATE_MAX_SPEECHES } from '../dist/rooms/debate.js';

function fixture(names = ['Alpha', 'Beta', 'Gamma', 'Delta']) {
  const dir = mkdtempSync(join(tmpdir(), 'debate-room-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bots = names.map(name => createBot(facade, { name }));
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of bots) store.updateSession(bot.canonicalSessionId, { metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal } });
  const calls = [];
  const f = { store, facade, bots, principal, calls, say: call => `speech ${call.n} by ${call.name}` };
  f.host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      const agentId = store.getSession(id).agentId;
      const prompt = store.listMessages(id).filter(message => message.role === 'user').at(-1).parts.find(part => part.type === 'text').text;
      const call = { n: calls.length + 1, botId: agentId, name: bots.find(bot => bot.id === agentId).name, prompt, sessionId: id };
      calls.push(call);
      const text = await f.say(call);
      if (text !== null) store.appendMessage(id, 'assistant', [{ type: 'text', text }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  f.rooms = new BotRoomService(f.host);
  return f;
}

function botPosts(f, roomId) {
  return f.rooms.messages(f.principal, roomId, { limit: 200 }).messages.filter(message => message.sender.type === 'bot');
}

function debateRoom(f, members, debate, extra = {}) {
  const room = f.rooms.create(f.principal, { title: 'Debate', botIds: members.map(bot => bot.id), hostBotId: members[0].id, ...extra });
  return f.rooms.patch(f.principal, room.id, { replyMode: 'debate', ...(debate ? { debate } : {}) });
}

test('debate mode and its settings are saved on the room, and bad settings are refused [AC:room-debate-mode#AC-1]', () => {
  const f = fixture();
  const [alpha, beta, gamma, delta] = f.bots;
  const room = f.rooms.create(f.principal, { title: 'Saved', botIds: [alpha.id, beta.id, gamma.id], hostBotId: alpha.id });
  const debate = { rounds: 4, participants: [{ botId: gamma.id, stance: '支持远程办公' }, { botId: beta.id, stance: '反对远程办公' }], judgeBotId: alpha.id };
  const saved = f.rooms.patch(f.principal, room.id, { replyMode: 'debate', debate });
  assert.equal(saved.replyMode, 'debate');
  assert.deepEqual(saved.debate, debate);
  const reopened = new BotRoomService(f.host).get(f.principal, room.id);
  assert.equal(reopened.replyMode, 'debate');
  assert.deepEqual(reopened.debate, debate);
  assert.equal(f.rooms.patch(f.principal, room.id, { debate: { judgeBotId: null } }).debate.judgeBotId, null);
  assert.equal(f.rooms.patch(f.principal, room.id, { debate: null }).debate, undefined);

  const bad = [
    [{ rounds: 0 }, /rounds/i],
    [{ rounds: 11 }, /rounds/i],
    [{ rounds: 1.5 }, /rounds/i],
    [{ participants: [{ botId: alpha.id }, { botId: delta.id }] }, /Room member/],
    [{ participants: [{ botId: alpha.id }] }, /2 to 8/],
    [{ participants: [{ botId: alpha.id }, { botId: alpha.id }] }, /twice/],
    [{ participants: [{ botId: alpha.id }, { botId: beta.id }], judgeBotId: alpha.id }, /judge cannot also/],
    [{ participants: [{ botId: alpha.id, stance: 'x'.repeat(61) }, { botId: beta.id }] }, /stance/i],
    [{ judgeBotId: delta.id }, /judge must be a Room member/],
    ['debate', /object/]
  ];
  for (const [input, pattern] of bad) assert.throws(() => f.rooms.patch(f.principal, room.id, { debate: input }), pattern, JSON.stringify(input));
  assert.throws(() => f.rooms.patch(f.principal, room.id, { replyMode: 'argue' }), /replyMode must be/);
  const big = fixture(['A', 'B', 'C', 'D', 'E']);
  const crowd = big.rooms.create(big.principal, { title: 'Crowd', botIds: big.bots.map(bot => bot.id) });
  assert.throws(() => big.rooms.patch(big.principal, crowd.id, { debate: { rounds: 10, participants: big.bots.map(bot => ({ botId: bot.id })) } }), /at most 40/);
  assert.equal(big.rooms.patch(big.principal, crowd.id, { debate: { rounds: 8, participants: big.bots.map(bot => ({ botId: bot.id })) } }).debate.rounds, 8);
});

test('an unconfigured debate room uses the host as judge and the others as the two sides [AC:room-debate-mode#AC-2]', async () => {
  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  const room = debateRoom(f, [alpha, beta, gamma]);
  const sent = f.rooms.send(f.principal, room.id, { text: '远程办公利大于弊吗' });
  assert.equal(sent.turn.replyMode, 'debate');
  assert.deepEqual(sent.turn.debate.participants, [{ botId: beta.id, stance: '正方' }, { botId: gamma.id, stance: '反方' }]);
  assert.equal(sent.turn.debate.judgeBotId, alpha.id);
  assert.equal(sent.turn.debate.rounds, 3);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, room.id).map(message => message.sender.name), ['Beta', 'Gamma', 'Beta', 'Gamma', 'Beta', 'Gamma', 'Alpha']);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.terminationReason, 'members_completed');

  const pair = fixture(['Left', 'Right']);
  const two = debateRoom(pair, pair.bots);
  const plan = pair.rooms.send(pair.principal, two.id, { text: 'topic' }).turn.debate;
  assert.equal(plan.judgeBotId, undefined);
  await pair.rooms.tick();
  assert.deepEqual(botPosts(pair, two.id).map(message => message.sender.name), ['Left', 'Right', 'Left', 'Right', 'Left', 'Right']);
});

test('debaters speak one after another for the saved rounds, then the judge closes the turn [AC:room-debate-mode#AC-3] [AC:room-debate-mode#AC-6]', async () => {
  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  const room = debateRoom(f, [alpha, beta, gamma], { rounds: 2, participants: [{ botId: gamma.id, stance: '赞成' }, { botId: alpha.id, stance: '反对' }], judgeBotId: beta.id });
  let active = 0;
  let peak = 0;
  f.say = async call => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return `speech ${call.n} by ${call.name}`;
  };
  f.rooms.send(f.principal, room.id, { text: '应该每周工作四天吗' });
  await f.rooms.tick();
  assert.equal(peak, 1);
  const posts = botPosts(f, room.id);
  assert.deepEqual(posts.map(message => message.text), ['speech 1 by Gamma', 'speech 2 by Alpha', 'speech 3 by Gamma', 'speech 4 by Alpha', 'speech 5 by Beta']);
  const keys = f.store.db.prepare("SELECT idem_key FROM bot_room_messages WHERE room_id=? AND idem_key LIKE 'reply:%' ORDER BY seq").all(room.id).map(row => row.idem_key);
  assert.equal(new Set(keys).size, 5);
  assert.match(keys.at(-1), /:verdict$/);

  const verdict = f.calls.at(-1).prompt;
  assert.match(verdict, /You are the judge/);
  assert.match(verdict, /Summarize the strongest arguments of each side/);
  assert.match(verdict, /give a clear verdict/);
  assert.match(verdict, /\[Debate Speeches In Full\]/);
  for (const n of [1, 2, 3, 4]) assert.ok(verdict.includes(`speech ${n} by`), `judge sees speech ${n}`);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
  assert.equal(turn.botTurns, 5);
  assert.equal(turn.maxBotTurns, 5);
});

test('each speaker sees every earlier speech, and the latest opposing speech is not shortened [AC:room-debate-mode#AC-4]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = debateRoom(f, [alpha, beta], { rounds: 2 });
  const long = n => `LONG-${n}-START ${'argument '.repeat(600)}LONG-${n}-END`;
  f.say = call => long(call.n);
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  assert.equal(f.calls.length, 4);
  assert.ok(long(1).length > 2000);
  for (const call of f.calls.slice(1)) {
    for (let n = 1; n < call.n; n += 1) assert.ok(call.prompt.includes(`LONG-${n}-START`), `speech ${call.n} sees speech ${n}`);
    const section = call.prompt.slice(call.prompt.indexOf('[Latest Opposing Speeches In Full]'));
    assert.ok(section.includes(long(call.n - 1)), `speech ${call.n} has the previous speech whole`);
  }
  assert.ok(!f.calls[0].prompt.includes('[Latest Opposing Speeches In Full]'));

  // Past the recent window, older speeches of the same debate are still listed.
  const lines = Array.from({ length: 12 }, (_, index) => ({ seq: index + 2, senderId: index % 2 ? 'b' : 'a', senderName: index % 2 ? 'B' : 'A', text: `point ${index + 1}` }));
  const block = debateFullTextBlock(lines, 'a', false, new Set([12, 13]));
  assert.match(block, /\[Earlier Debate Speeches\]/);
  for (let n = 1; n <= 10; n += 1) assert.ok(block.includes(`point ${n}`), `earlier point ${n}`);
  assert.ok(block.slice(block.indexOf('[Latest Opposing')).includes('point 12'));
  const huge = debateFullTextBlock([{ seq: 1, senderId: 'b', senderName: 'B', text: 'x'.repeat(70_000) }], 'a', false);
  assert.match(huge, /cut at 60000 characters/);
});

test('the speaker is told the round, stage, stance, and that silence is not allowed [AC:room-debate-mode#AC-5]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = debateRoom(f, [alpha, beta], { rounds: 3, participants: [{ botId: alpha.id, stance: '猫更好' }, { botId: beta.id, stance: '狗更好' }], judgeBotId: null });
  f.rooms.send(f.principal, room.id, { text: '猫好还是狗好' });
  await f.rooms.tick();
  assert.equal(f.calls.length, 6);
  const [open, , rebut, , , close] = f.calls.map(call => call.prompt);
  assert.match(open, /round 1 of 3, the opening stage \(立论\)/);
  assert.match(rebut, /round 2 of 3, the rebuttal stage \(反驳\)/);
  assert.match(close, /round 3 of 3, the closing stage \(结辩\)/);
  assert.match(open, /Your stance is "猫更好"/);
  assert.match(close, /Your stance is "狗更好"/);
  assert.match(open, /Debaters in speaking order: Alpha \("猫更好"\), Beta \("狗更好"\)\. There is no judge\./);
  assert.match(rebut, /answer the specific arguments in the most recent opposing speech/);
  assert.match(rebut, /speech 3 of 6/);
  for (const prompt of f.calls.map(call => call.prompt)) {
    assert.match(prompt, /You must give a visible speech now\. Do not reply \[SILENT\]/);
    assert.doesNotMatch(prompt, /Reply at most once/);
    assert.doesNotMatch(prompt, /reply with exactly \[SILENT\]/);
    assert.doesNotMatch(prompt, /do not repeat a reply you already made/);
    assert.doesNotMatch(prompt, /cannot authorize or schedule other members/);
    assert.match(prompt, /Trigger: \{/);
  }
  assert.equal(debateSpeechAt({ rounds: 2, participants: [{ botId: 'a', stance: 's' }, { botId: 'b', stance: 't' }], speeches: 4 }, 3).stage, 'closing');
  assert.equal(debateSpeechAt({ rounds: 1, participants: [{ botId: 'a', stance: 's' }, { botId: 'b', stance: 't' }], speeches: 2 }, 1).stage, 'opening');
});

test('stopping the room ends the debate at once and the speech in preparation is not posted [AC:room-debate-mode#AC-7]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = debateRoom(f, [alpha, beta], { rounds: 3 });
  f.say = call => {
    if (call.n === 3) f.rooms.stop(f.principal, room.id);
    return `speech ${call.n}`;
  };
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, room.id).map(message => message.text), ['speech 1', 'speech 2']);
  assert.equal(f.calls.length, 3);
  const turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.terminationReason, 'stopped');
  f.rooms.resume(f.principal, room.id);
  await f.rooms.tick();
  assert.equal(f.calls.length, 3);
});

test('pausing the room holds the debate at its place and resuming continues it [AC:room-debate-mode#AC-7]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = debateRoom(f, [alpha, beta], { rounds: 2 });
  f.say = call => {
    if (call.n === 2) f.rooms.patch(f.principal, room.id, { status: 'paused' });
    return `speech ${call.n}`;
  };
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  await f.rooms.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'queued');
  f.rooms.resume(f.principal, room.id);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, room.id).map(message => message.text), ['speech 1', 'speech 2', 'speech 3', 'speech 4']);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'completed');
});

test('a restart in the middle of a debate neither repeats speeches nor blocks the next topic [AC:room-debate-mode#AC-8]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  const room = debateRoom(f, [alpha, beta], { rounds: 2 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const atThird = new Promise(resolve => { reached = resolve; });
  f.say = async call => {
    if (call.n === 3) { reached(); await gate; return null; }
    return `speech ${call.n}`;
  };
  f.rooms.send(f.principal, room.id, { text: 'first topic' });
  const crashed = f.rooms.tick();
  await atThird;

  // A new service on the same database is what the process sees after a restart.
  const after = fixture.restart(f);
  const first = after.rooms.turns(f.principal, room.id)[0];
  assert.equal(first.status, 'unknown');
  assert.equal(first.terminationReason, 'interrupted_requires_review');
  await after.rooms.tick();
  assert.deepEqual(botPosts(after, room.id).map(message => message.text), ['speech 1', 'speech 2']);

  after.rooms.send(f.principal, room.id, { text: 'second topic' });
  await after.rooms.tick();
  const posts = botPosts(after, room.id).map(message => message.text);
  assert.deepEqual(posts, ['speech 1', 'speech 2', 'again 1', 'again 2', 'again 3', 'again 4']);
  assert.equal(after.rooms.turns(f.principal, room.id)[1].status, 'completed');
  release();
  await crashed;
  assert.equal(botPosts(after, room.id).length, 6);
});

fixture.restart = f => {
  const calls = [];
  const host = {
    ...f.host,
    runSession: async id => {
      calls.push(id);
      f.store.appendMessage(id, 'assistant', [{ type: 'text', text: `again ${calls.length}` }]);
      f.store.updateSession(id, { status: 'idle' });
    }
  };
  return { ...f, host, calls, rooms: new BotRoomService(host) };
};

test('the total number of speeches is bounded, and a reply cap keeps one reply for the judge [AC:room-debate-mode#AC-9]', async () => {
  const members = { botIds: ['h', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j'], hostBotId: 'h' };
  const wide = resolveDebatePlan({ rounds: 10 }, members);
  assert.equal(wide.participants.length, 8);
  assert.equal(wide.judgeBotId, 'h');
  assert.ok(wide.speeches <= DEBATE_MAX_SPEECHES);
  assert.equal(wide.rounds, 5);
  assert.deepEqual(resolveDebatePlan({ rounds: 3 }, { botIds: ['h', 'a', 'b'], hostBotId: 'h' }, 4), { rounds: 3, participants: [{ botId: 'a', stance: '正方' }, { botId: 'b', stance: '反方' }], judgeBotId: 'h', speeches: 3 });
  assert.equal(resolveDebatePlan({}, { botIds: ['h', 'a', 'b'], hostBotId: 'h' }, 1).judgeBotId, undefined);
  assert.equal(resolveDebatePlan({}, { botIds: ['h', 'a', 'b'], hostBotId: 'h' }, 1).speeches, 1);
  // A saved debater who left the room is dropped; too few left means everyone but the judge debates.
  assert.deepEqual(resolveDebatePlan({ participants: [{ botId: 'gone' }, { botId: 'a', stance: 'x' }], judgeBotId: 'gone' }, { botIds: ['h', 'a', 'b'], hostBotId: 'h' }).participants.map(item => item.botId), ['a', 'b']);
  assert.equal(resolveDebatePlan({ participants: [{ botId: 'h' }, { botId: 'a' }] }, { botIds: ['h', 'a', 'b'], hostBotId: 'h' }).judgeBotId, undefined);

  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  const room = debateRoom(f, [alpha, beta, gamma], { rounds: 3 }, { maxBotTurns: 4 });
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, room.id).map(message => message.sender.name), ['Beta', 'Gamma', 'Beta', 'Alpha']);
  assert.match(f.calls.at(-1).prompt, /You are the judge/);

  const costly = debateRoom(f, [alpha, beta], { rounds: 3 }, { maxToolCalls: 1 });
  f.calls.length = 0;
  f.host.runSession = async id => {
    f.calls.push(id);
    f.rooms.budgetHookForSession(id)({ type: 'model_done', assistant: { parts: [{ type: 'tool_call' }, { type: 'tool_call' }] } });
    f.store.updateSession(id, { status: 'idle' });
  };
  f.rooms.send(f.principal, costly.id, { text: 'topic' });
  await f.rooms.tick();
  const stopped = f.rooms.turns(f.principal, costly.id)[0];
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.terminationReason, 'tool_budget');
  assert.equal(f.calls.length, 1);
  assert.equal(botPosts(f, costly.id).length, 0);
});

test('the per-minute reply cap makes the debate wait and then continue where it stopped [AC:room-debate-mode#AC-10]', async () => {
  const f = fixture();
  const [alpha, beta] = f.bots;
  f.rooms.writeSettings({ maxRepliesPerMinute: 2 });
  const room = debateRoom(f, [alpha, beta], { rounds: 2 });
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  let posts = botPosts(f, room.id);
  assert.deepEqual(posts.slice(0, 2).map(message => message.text), ['speech 1 by Alpha', 'speech 2 by Beta']);
  assert.match(posts[2].text, /每分钟上限/);
  let turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'queued');
  assert.equal(turn.debate.step, 2);
  await f.rooms.tick();
  assert.equal(f.calls.length, 2);

  // The minute passes: clear the recorded reply times and the wait.
  const stored = JSON.parse(f.store.db.prepare('SELECT data FROM bot_rooms WHERE id=?').get(room.id).data);
  f.store.db.prepare('UPDATE bot_rooms SET data=? WHERE id=?').run(JSON.stringify({ ...stored, recentReplyAts: [] }), room.id);
  f.store.db.prepare('UPDATE bot_room_turns SET data=? WHERE id=?').run(JSON.stringify({ ...turn, replyResumeAt: new Date(Date.now() - 1000).toISOString() }), turn.id);
  await f.rooms.tick();
  posts = botPosts(f, room.id).filter(message => !/每分钟上限/.test(message.text));
  assert.deepEqual(posts.map(message => message.text), ['speech 1 by Alpha', 'speech 2 by Beta', 'speech 3 by Alpha', 'speech 4 by Beta']);
  turn = f.rooms.turns(f.principal, room.id)[0];
  assert.equal(turn.status, 'completed');
});

test('a failed or silent speech leaves a note and the debate goes on to the verdict [AC:room-debate-mode#AC-11]', async () => {
  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  const room = debateRoom(f, [alpha, beta, gamma], { rounds: 2 });
  f.say = call => {
    if (call.n === 2) return '[SILENT]';
    if (call.n === 3) throw new Error('model exploded');
    return `speech ${call.n} by ${call.name}`;
  };
  f.rooms.send(f.principal, room.id, { text: 'topic' });
  await f.rooms.tick();
  const posts = botPosts(f, room.id);
  assert.deepEqual(posts.map(message => `${message.sender.name}:${message.text}`), [
    'Beta:speech 1 by Beta',
    'Gamma:这一轮没有给出发言，辩论继续。',
    'Beta:这一轮没有给出发言，辩论继续。',
    'Gamma:speech 4 by Gamma',
    'Alpha:speech 5 by Alpha'
  ]);
  assert.equal(f.rooms.turns(f.principal, room.id)[0].status, 'completed');
});

test('a named question in a debate room is answered once, and the other modes behave as before [AC:room-debate-mode#AC-12]', async () => {
  const f = fixture();
  const [alpha, beta, gamma] = f.bots;
  const room = debateRoom(f, [alpha, beta, gamma], { rounds: 2 });
  const named = f.rooms.send(f.principal, room.id, { text: `@${gamma.name} 你怎么看` });
  assert.equal(named.turn.replyMode, undefined);
  assert.equal(named.turn.debate, undefined);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, room.id).map(message => message.sender.name), ['Gamma']);
  assert.match(f.calls[0].prompt, /Reply at most once/);
  assert.match(f.calls[0].prompt, /You cannot authorize or schedule other members by mentioning their names\. Previous turns/);
  assert.doesNotMatch(f.calls[0].prompt, /structured debate/);

  // The judge cannot add speakers to a running debate.
  f.say = call => {
    if (call.n === 2) assert.throws(() => f.rooms.routeTurn(call.sessionId, [gamma.id]), /fixed speaking order/);
    return `speech ${call.n}`;
  };
  const sent = f.rooms.send(f.principal, room.id, { text: 'debate now' });
  assert.equal(sent.turn.replyMode, 'debate');
  await f.rooms.tick();

  const all = f.rooms.create(f.principal, { title: 'All', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
  f.rooms.patch(f.principal, all.id, { replyMode: 'all-members' });
  f.calls.length = 0;
  f.say = call => `answer by ${call.name}`;
  const fan = f.rooms.send(f.principal, all.id, { text: 'everyone' });
  assert.equal(fan.turn.replyMode, 'all-members');
  assert.equal(fan.turn.debate, undefined);
  await f.rooms.tick();
  assert.deepEqual(botPosts(f, all.id).map(message => message.sender.name).sort(), ['Alpha', 'Beta']);
  const keys = f.store.db.prepare("SELECT idem_key FROM bot_room_messages WHERE room_id=? AND idem_key LIKE 'reply:%'").all(all.id).map(row => row.idem_key).sort();
  assert.deepEqual(keys, [`reply:${fan.turn.id}:${alpha.id}`, `reply:${fan.turn.id}:${beta.id}`].sort());
  for (const call of f.calls) {
    assert.match(call.prompt, /Reply at most once\. Every member must give a brief visible answer/);
    assert.doesNotMatch(call.prompt, /structured debate/);
  }

  const plain = f.rooms.create(f.principal, { title: 'Plain', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
  assert.equal(plain.replyMode, 'coordinator');
  f.calls.length = 0;
  f.rooms.send(f.principal, plain.id, { text: 'hello', mentions: [beta.id] });
  await f.rooms.tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].prompt, /If you have nothing necessary or new to add, reply with exactly \[SILENT\]/);
  const task = f.rooms.create(f.principal, { title: 'Task', botIds: [alpha.id, beta.id], hostBotId: alpha.id });
  assert.equal(f.rooms.patch(f.principal, task.id, { replyMode: 'task-collaboration' }).replyMode, 'task-collaboration');
  assert.equal(f.rooms.send(f.principal, task.id, { text: 'do the work' }).turn.replyMode, 'task-collaboration');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, deliverBotRoomMessage } from '../dist/rooms/index.js';
import { isRestrainedMember, restraintHint } from '../dist/rooms/scheduling.js';
import { prepareTurnInput } from '../dist/runtime/prepare-turn-input.js';

const fullReply = `${'quoted body '.repeat(20)}TAIL_MARKER_94`;
const excerpt = fullReply.slice(0, 120);

function sessionRecord(id) {
  return {
    id,
    title: 'bot',
    mode: 'chat',
    status: 'idle',
    agentId: 'bot_a',
    background: false,
    todo: [],
    metadata: {},
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z'
  };
}

test('a quoted bot reply is given in full to the answering bot [AC:bot-reply-quote#AC-1]', async () => {
  assert.ok(!excerpt.includes('TAIL_MARKER_94'));
  const botReply = {
    id: 'msg_bot',
    sessionId: 'sess',
    role: 'assistant',
    parts: [
      { type: 'text', text: fullReply },
      { type: 'reasoning', text: 'PRIVATE_REASONING' }
    ],
    createdAt: '2026-10-19T00:00:00.000Z'
  };
  const plain = {
    id: 'msg_plain',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'unrelated earlier question' }],
    createdAt: '2026-10-19T00:00:01.000Z'
  };
  const quoted = {
    id: 'msg_user',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'what about the second point?' }],
    createdAt: '2026-10-19T00:00:02.000Z',
    replyTo: { messageId: 'msg_bot', botId: 'bot_a', excerpt }
  };
  const packed = await prepareTurnInput('sess', {
    store: {
      getSession: () => sessionRecord('sess'),
      foldMessages: () => [plain, botReply, quoted],
      appendMessage: () => quoted,
      hideByKey: () => 0
    },
    autoCompact: async () => {},
    claimNextStep: () => [],
    prepareView: async (_session, messages) => messages,
    buildAppendix: async () => ''
  });
  const modelUser = packed.messages.find(message => message.id === 'msg_user');
  const shown = modelUser.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(shown, /TAIL_MARKER_94/);
  assert.match(shown, /msg_bot/);
  assert.match(shown, /what about the second point\?/);
  assert.match(shown, /quoted/);
  assert.doesNotMatch(shown, /PRIVATE_REASONING/);
  assert.equal(quoted.parts.length, 1);
  assert.equal(quoted.parts[0].text, 'what about the second point?');
  const plainShown = packed.messages.find(message => message.id === 'msg_plain').parts.map(part => part.text).join('\n');
  assert.doesNotMatch(plainShown, /TAIL_MARKER_94/);
  assert.doesNotMatch(plainShown, /msg_bot/);
});

function roomFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-reply-quote-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const alpha = createBot(facade, { name: 'Alpha' });
  const beta = createBot(facade, { name: 'Beta' });
  const principal = { userId: 'owner', tenantId: 'team' };
  for (const bot of [alpha, beta]) {
    const session = store.getSession(bot.canonicalSessionId);
    store.updateSession(bot.canonicalSessionId, { metadata: { ...session.metadata, ...principal } });
  }
  const prompts = [];
  const host = {
    store,
    createChatSession: input => createChatSession(facade, input),
    runSession: async id => {
      const session = store.getSession(id);
      const text = store.listMessages(id).flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n');
      prompts.push({ botId: session.agentId, text });
      store.appendMessage(id, 'assistant', [{ type: 'text', text: 'ok' }]);
      store.updateSession(id, { status: 'idle' });
    },
    cancelSession: id => store.updateSession(id, { status: 'idle' })
  };
  return { store, rooms: new BotRoomService(host), alpha, beta, prompts, principal };
}

test('quoting one room bot addresses only that bot and keeps the full reply [AC:bot-reply-quote#AC-4]', async () => {
  const f = roomFixture();
  try {
    assert.ok(!excerpt.includes('TAIL_MARKER_94'));
    const room = f.rooms.create(f.principal, { title: 'Team', botIds: [f.alpha.id, f.beta.id], hostBotId: f.alpha.id });
    const delivered = deliverBotRoomMessage(f.store, {
      roomId: room.id,
      botId: f.beta.id,
      principal: f.principal,
      text: fullReply,
      idempotencyKey: 'beta-reply'
    });
    assert.equal(delivered.delivered, true);
    const sent = f.rooms.send(f.principal, room.id, {
      text: 'explain this',
      replyTo: { messageId: delivered.message.id, botId: f.beta.id, excerpt }
    });
    assert.equal(sent.message.text, 'explain this');
    assert.ok(!JSON.stringify(sent.message).includes('TAIL_MARKER_94'));
    assert.deepEqual(sent.turn.mentionedBotIds, [f.beta.id]);
    assert.equal(sent.turn.botIds[0], f.beta.id);
    assert.equal(isRestrainedMember(sent.turn, f.alpha.id), true);
    assert.equal(isRestrainedMember(sent.turn, f.beta.id), false);
    assert.match(restraintHint(sent.turn, f.alpha.id), /\[SILENT\]/);
    assert.equal(restraintHint(sent.turn, f.beta.id), '');
    await f.rooms.tick();
    const betaPrompt = f.prompts.find(prompt => prompt.botId === f.beta.id);
    const alphaPrompt = f.prompts.find(prompt => prompt.botId === f.alpha.id);
    assert.ok(betaPrompt);
    assert.ok(alphaPrompt);
    const quoted = new RegExp(`\\[reply-quote\\] target=${delivered.message.id}[\\s\\S]*TAIL_MARKER_94`);
    assert.match(betaPrompt.text, quoted);
    assert.doesNotMatch(betaPrompt.text, /not @-mentioned/);
    assert.match(alphaPrompt.text, quoted);
    assert.match(alphaPrompt.text, /not @-mentioned/);
    assert.match(alphaPrompt.text, /\[SILENT\]/);

    f.prompts.length = 0;
    const named = f.rooms.send(f.principal, room.id, {
      text: `please @${f.alpha.name} look`,
      replyTo: { messageId: delivered.message.id, botId: f.beta.id, excerpt }
    });
    assert.deepEqual(named.turn.mentionedBotIds, [f.alpha.id]);
    assert.equal(isRestrainedMember(named.turn, f.beta.id), true);
    assert.equal(isRestrainedMember(named.turn, f.alpha.id), false);
    await f.rooms.tick();
    const alphaNamed = f.prompts.find(prompt => prompt.botId === f.alpha.id);
    const betaNamed = f.prompts.find(prompt => prompt.botId === f.beta.id);
    const quotedAgain = new RegExp(`\\[reply-quote\\] target=${delivered.message.id}[\\s\\S]*TAIL_MARKER_94`);
    assert.match(alphaNamed.text, quotedAgain);
    assert.match(betaNamed.text, /not @-mentioned/);
    assert.match(betaNamed.text, quotedAgain);
  } finally {
    f.store.db.close();
  }
});

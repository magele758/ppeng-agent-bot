import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime, ValidationError } from '../dist/index.js';
import { sessionsRoutes } from '../../../apps/daemon/dist/routes/sessions.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession } from '../dist/runtime/session-facade.js';
import { BotRoomService, deliverBotRoomMessage } from '../dist/rooms/index.js';
import { isRestrainedMember, restraintHint } from '../dist/rooms/scheduling.js';
import { prepareTurnInput } from '../dist/runtime/prepare-turn-input.js';

const FULL_BODY = `FULL-BOT-BODY-${'q'.repeat(300)}-TAIL`;

function makeRuntime(repoRoot, stateDir) {
  return new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'stub',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'should-not-run' }] };
      }
    }
  });
}

function openRuntime() {
  return makeRuntime(
    mkdtempSync(join(tmpdir(), 'reply-quote-repo-')),
    mkdtempSync(join(tmpdir(), 'reply-quote-state-'))
  );
}

async function call(runtime, method, pattern, params, body) {
  const route = sessionsRoutes(runtime).find((item) => item.method === method && item.pattern === pattern);
  assert.ok(route, `${method} ${pattern}`);
  const out = { status: 200, body: undefined };
  const response = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      out.status = this.statusCode;
      out.body = text ? JSON.parse(String(text)) : undefined;
    }
  };
  const path = pattern.replace(':id', params.id ?? '');
  await route.handler({
    request: { method, headers: {} },
    response,
    url: new URL(`http://127.0.0.1${path}`),
    parts: [],
    params,
    requireParam: (name) => {
      const value = params[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
    readBody: async () => body ?? {},
    auth: ANONYMOUS_AUTH
  });
  return out;
}

function userWithText(messages, text) {
  return messages.find(
    (message) => message.role === 'user' && message.parts.some((part) => part.type === 'text' && part.text === text)
  );
}

test('quoted user message keeps excerpt and source after reopen [AC:bot-reply-quote#AC-5]', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'reply-quote-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'reply-quote-state-'));
  const runtime = makeRuntime(repoRoot, stateDir);
  const session = runtime.createChatSession({ title: 'quotes' });
  const bot = runtime.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: FULL_BODY }]);
  const excerpt = 'the part about tails';
  const posted = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
    message: 'explain that bit',
    autoRun: false,
    replyTo: { messageId: bot.id, botId: 'bot-alpha', excerpt, text: FULL_BODY }
  });
  assert.equal(posted.status, 200);
  const user = userWithText(posted.body.messages, 'explain that bit');
  assert.ok(user);
  assert.deepEqual(user.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
  assert.equal(JSON.stringify(user).includes('FULL-BOT-BODY-'), false);
  assert.equal(user.parts.map((part) => part.text ?? '').join('\n').includes(FULL_BODY), false);
  const userId = user.id;
  await runtime.destroy();

  const reloaded = makeRuntime(repoRoot, stateDir);
  try {
    const got = await call(reloaded, 'GET', '/api/sessions/:id', { id: session.id });
    assert.equal(got.status, 200);
    const again = got.body.messages.find((message) => message.id === userId);
    assert.ok(again);
    assert.deepEqual(again.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
    assert.equal(JSON.stringify(again).includes('FULL-BOT-BODY-'), false);
    const stored = reloaded.getSessionMessages(session.id).find((message) => message.id === userId);
    assert.deepEqual(stored.replyTo, { messageId: bot.id, botId: 'bot-alpha', excerpt });
    assert.deepEqual(reloaded.store.foldMessages(session.id).find((message) => message.id === userId).replyTo, stored.replyTo);
    assert.deepEqual(reloaded.store.readHistoryById(session.id, userId).replyTo, stored.replyTo);
  } finally {
    await reloaded.destroy();
  }
});

test('API accepts a quote of an older bot message [AC:bot-reply-quote#AC-6]', async () => {
  const runtime = openRuntime();
  try {
    const session = runtime.createChatSession({ title: 'older quote' });
    const older = runtime.store.appendMessage(session.id, 'assistant', [
      { type: 'text', text: `${FULL_BODY}-OLD` }
    ]);
    runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'a later question' }]);
    const newer = runtime.store.appendMessage(session.id, 'assistant', [
      { type: 'text', text: `${FULL_BODY}-NEW` }
    ]);

    const posted = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'about the first one',
      autoRun: false,
      replyTo: { messageId: older.id, botId: 'bot-alpha', excerpt: 'older excerpt', body: `${FULL_BODY}-OLD` }
    });
    const olderQuote = userWithText(posted.body.messages, 'about the first one');
    assert.deepEqual(olderQuote.replyTo, {
      messageId: older.id,
      botId: 'bot-alpha',
      excerpt: 'older excerpt'
    });
    assert.equal(JSON.stringify(olderQuote).includes('FULL-BOT-BODY-'), false);

    const recent = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'about the latest one',
      autoRun: false,
      replyTo: { messageId: newer.id, botId: 'bot-alpha', excerpt: 'newer excerpt' }
    });
    const newerQuote = userWithText(recent.body.messages, 'about the latest one');
    assert.deepEqual(newerQuote.replyTo, {
      messageId: newer.id,
      botId: 'bot-alpha',
      excerpt: 'newer excerpt'
    });
    assert.deepEqual(Object.keys(olderQuote.replyTo).sort(), Object.keys(newerQuote.replyTo).sort());
    assert.notEqual(olderQuote.replyTo.messageId, newerQuote.replyTo.messageId);
  } finally {
    await runtime.destroy();
  }
});

test('replyTo rejects a missing message and a user message', async () => {
  const runtime = openRuntime();
  try {
    const session = runtime.createChatSession({ title: 'reject quote' });
    const mine = runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'my own note' }]);
    runtime.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'a bot reply' }]);

    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'missing target',
          autoRun: false,
          replyTo: { messageId: 'msg_missing', botId: 'bot-alpha', excerpt: 'gone' }
        }),
      (error) => error instanceof ValidationError && /not found/i.test(error.message)
    );
    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'quote myself',
          autoRun: false,
          replyTo: { messageId: mine.id, botId: 'bot-alpha', excerpt: 'my own note' }
        }),
      (error) => error instanceof ValidationError && /bot reply/i.test(error.message)
    );
    await assert.rejects(
      () =>
        call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
          message: 'too long',
          autoRun: false,
          replyTo: { messageId: mine.id, botId: 'bot-alpha', excerpt: 'x'.repeat(121) }
        }),
      (error) => error instanceof ValidationError && /120/.test(error.message)
    );

    const plain = await call(runtime, 'POST', '/api/sessions/:id/messages', { id: session.id }, {
      message: 'ordinary',
      autoRun: false
    });
    const ordinary = userWithText(plain.body.messages, 'ordinary');
    assert.equal(ordinary.replyTo, undefined);
    assert.equal(
      runtime.getSessionMessages(session.id).some((message) => message.parts.some((part) => part.text === 'quote myself')),
      false
    );
  } finally {
    await runtime.destroy();
  }
});

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

test('prompt assembly loads the quoted reply by messageId when it is outside the fold [AC:bot-reply-quote#AC-1]', async () => {
  const botReply = {
    id: 'msg_old',
    sessionId: 'sess',
    role: 'assistant',
    parts: [{ type: 'text', text: fullReply }],
    createdAt: '2026-10-19T00:00:00.000Z'
  };
  const quoted = {
    id: 'msg_user',
    sessionId: 'sess',
    role: 'user',
    parts: [{ type: 'text', text: 'about that earlier reply' }],
    createdAt: '2026-10-19T00:00:02.000Z',
    replyTo: { messageId: 'msg_old', botId: 'bot_a', excerpt }
  };
  const packed = await prepareTurnInput('sess', {
    store: {
      getSession: () => sessionRecord('sess'),
      foldMessages: () => [quoted],
      readHistoryById: (sessionId, messageId) =>
        sessionId === 'sess' && messageId === 'msg_old' ? botReply : undefined,
      appendMessage: () => quoted,
      hideByKey: () => 0
    },
    autoCompact: async () => {},
    claimNextStep: () => [],
    prepareView: async (_session, messages) => messages,
    buildAppendix: async () => ''
  });
  const shown = packed.messages.find(message => message.id === 'msg_user').parts.map(part => part.text).join('\n');
  assert.match(shown, /TAIL_MARKER_94/);
  assert.match(shown, /msg_old/);
  assert.equal(quoted.parts.length, 1);
  assert.equal(quoted.parts[0].text, 'about that earlier reply');
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
    assert.deepEqual(sent.message.replyTo, { messageId: delivered.message.id, botId: f.beta.id, excerpt: excerpt.trim() });
    const listed = f.rooms.messages(f.principal, room.id).messages.find(message => message.id === sent.message.id);
    assert.deepEqual(listed.replyTo, sent.message.replyTo);
    assert.ok(!JSON.stringify(listed).includes('TAIL_MARKER_94'));
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

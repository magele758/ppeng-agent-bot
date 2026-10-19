import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime, ValidationError } from '../dist/index.js';
import { sessionsRoutes } from '../../../apps/daemon/dist/routes/sessions.js';

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

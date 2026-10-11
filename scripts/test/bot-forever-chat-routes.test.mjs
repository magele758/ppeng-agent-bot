import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANONYMOUS_AUTH, RawAgentRuntime } from '@ppeng/agent-core';
import { sessionsRoutes } from '../../apps/daemon/dist/routes/sessions.js';

function makeRuntime() {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'bfc-route-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'bfc-route-state-')),
    modelAdapter: {
      name: 'stub',
      calls: 0,
      async runTurn() {
        this.calls += 1;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'COMPACTED-SUMMARY';
      }
    }
  });
}

async function call(runtime, method, pattern, params, body) {
  const route = sessionsRoutes(runtime).find((item) => item.method === method && item.pattern === pattern);
  assert.ok(route, `${method} ${pattern}`);
  const out = { status: 200, body: undefined, raw: '' };
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      out.status = this.statusCode;
      out.raw = text ? String(text) : '';
      try {
        out.body = out.raw ? JSON.parse(out.raw) : undefined;
      } catch {
        out.body = undefined;
      }
    }
  };
  await route.handler({
    request: { method, headers: {} },
    response,
    url: new URL(`http://x${pattern}`),
    parts: [],
    params,
    requireParam: (name) => params[name],
    readBody: async () => body,
    auth: ANONYMOUS_AUTH
  });
  return out;
}

function seedTurns(store, sessionId) {
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'question-0' }]);
  store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: 'answer-0' }]);
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'question-1' }]);
  store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: 'answer-1' }]);
}

test('Lab 向 Bot 固定对话发送 /new 不新开会话 [AC:bot-forever-chat#AC-1] [AC:bot-forever-chat#AC-4]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'LabBot' });
  const sid = bot.canonicalSessionId;
  seedTurns(rt.store, sid);
  const idsBefore = rt.listSessions().map((session) => session.id);

  const posted = await call(rt, 'POST', '/api/sessions/:id/messages', { id: sid }, { message: '/new', autoRun: true });
  const streamed = await call(rt, 'POST', '/api/sessions/:id/stream', { id: sid }, { message: '/stop' });
  const model = await call(rt, 'POST', '/api/chat', {}, { botId: bot.id, message: '/model heuristic/heuristic' });

  assert.equal(posted.status, 200);
  assert.equal(posted.body?.command?.code, 'compacted');
  assert.equal(posted.body?.session?.id, sid);
  assert.equal(streamed.body?.command?.code, 'stopped');
  assert.equal(streamed.body?.session?.id, sid);
  assert.equal(model.body?.command?.code, 'model_set');
  assert.equal(model.body?.session?.id, sid);
  assert.deepEqual(rt.getSession(sid).metadata.modelOverride, { providerId: 'heuristic', modelId: 'heuristic' });
  assert.deepEqual(
    rt.listSessions().map((session) => session.id).sort(),
    [...idsBefore].sort()
  );
  assert.equal(rt.modelAdapter.calls, 0);
  assert.match(rt.getSession(sid).summary ?? '', /COMPACTED-SUMMARY/);
});

test('未选中 Bot 时 /new 不会压缩 Bot 对话 [AC:bot-forever-chat#AC-6]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Other' });
  seedTurns(rt.store, bot.canonicalSessionId);
  const plain = rt.createChatSession({ title: 'plain', message: 'hello', background: false });

  const res = await call(rt, 'POST', '/api/sessions/:id/messages', { id: plain.id }, { message: '/new', autoRun: false });

  assert.equal(res.body?.command, undefined);
  assert.equal(rt.getSession(bot.canonicalSessionId).summary ?? '', '');
  assert.ok(rt.getSessionMessages(plain.id).some((message) => message.role === 'user' && JSON.stringify(message.parts).includes('/new')));
});

test('创建会话时 /new 压缩 Bot 固定对话，普通消息写入同一会话 [AC:bot-forever-chat#AC-1]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Open' });
  seedTurns(rt.store, bot.canonicalSessionId);
  const before = rt.listSessions().map((session) => session.id).sort();

  const compacted = await call(rt, 'POST', '/api/sessions', {}, { botId: bot.id, message: '/new', autoRun: true });
  assert.equal(compacted.status, 200);
  assert.equal(compacted.body?.command?.code, 'compacted');
  assert.equal(compacted.body?.session?.id, bot.canonicalSessionId);

  const noted = await call(rt, 'POST', '/api/sessions', {}, { botId: bot.id, message: 'hello from lab', autoRun: false });
  assert.equal(noted.status, 201);
  assert.equal(noted.body?.session?.id, bot.canonicalSessionId);
  assert.equal(noted.body?.command, undefined);
  assert.ok(
    rt.getSessionMessages(bot.canonicalSessionId).some((message) => JSON.stringify(message.parts).includes('hello from lab'))
  );
  assert.deepEqual(rt.listSessions().map((session) => session.id).sort(), before);
  assert.equal(rt.modelAdapter.calls, 0);
});

function sseResponse() {
  const chunks = [];
  return {
    chunks,
    response: {
      statusCode: 200,
      writableEnded: false,
      destroyed: false,
      setHeader() {},
      flushHeaders() {},
      on() {
        return this;
      },
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
      end(text) {
        this.writableEnded = true;
        if (text) chunks.push(String(text));
      }
    }
  };
}

async function callStream(runtime, body) {
  const route = sessionsRoutes(runtime).find((item) => item.method === 'POST' && item.pattern === '/api/chat/stream');
  assert.ok(route);
  const sse = sseResponse();
  await route.handler({
    request: { method: 'POST', headers: {} },
    response: sse.response,
    url: new URL('http://x/api/chat/stream'),
    parts: [],
    params: {},
    requireParam: () => '',
    readBody: async () => body,
    auth: ANONYMOUS_AUTH
  });
  return { status: sse.response.statusCode, chunks: sse.chunks, body: sse.chunks.join('') };
}

test('流式入口上的 Bot 命令不新开会话，缺正文会拒绝 [AC:bot-forever-chat#AC-2] [AC:bot-forever-chat#AC-3]', async () => {
  const rt = makeRuntime();
  const bot = rt.createBot({ name: 'Stream' });
  const plain = rt.createChatSession({ title: 'plain', message: 'seed', background: false });
  const before = rt.listSessions().length;

  const stopped = await callStream(rt, { botId: bot.id, message: '/stop' });
  assert.equal(stopped.status, 200);
  assert.match(stopped.body, /"code": "stopped"/);
  assert.match(stopped.body, new RegExp(bot.canonicalSessionId));

  const continued = await callStream(rt, { sessionId: plain.id, message: 'follow up' });
  assert.match(continued.body, /event: result/);
  assert.match(continued.body, new RegExp(plain.id));

  const created = await callStream(rt, { title: 'fresh', message: 'brand new' });
  assert.match(created.body, /event: result/);
  assert.equal(rt.listSessions().length, before + 1);

  await assert.rejects(
    () => callStream(rt, { botId: bot.id, message: '   ' }),
    /Missing message/
  );
  assert.equal(rt.listSessions().length, before + 1);
});

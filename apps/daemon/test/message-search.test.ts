import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpStatusFromError, RawAgentRuntime, ResourceOwnerStore, filterSessionsByQuery, type RequestAuth } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { messageSearchRoutes } from '../dist/routes/message-search.js';
import { parseMessageSearchLimit, searchSessionMessageBodies, type MessageSearchDb } from '../dist/message-search.js';

type Hit = {
  sessionId: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: string;
  sessionTitle: string;
  agentId: string;
};

const HIT_KEYS = ['agentId', 'createdAt', 'messageId', 'role', 'sessionId', 'sessionTitle', 'snippet'];

function authFor(request: IncomingMessage): RequestAuth | undefined {
  if (request.headers['x-test-isolate'] !== '1') return undefined;
  const userId = request.headers['x-test-user'];
  return {
    isolate: true,
    labProxy: true,
    admin: false,
    user: userId ? { id: String(userId), tenantId: 't', email: `${userId}@example.test` } : null
  };
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'message-search-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'message-search',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async () => ({})
  }).addAll(messageSearchRoutes(runtime));
  const server = createServer((request, response) => {
    void router
      .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), authFor(request))
      .then((found) => {
        if (!found) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch((error: unknown) => {
        response.statusCode = httpStatusFromError(error);
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'object' && !('port' in address)) throw new Error('no port');
  const root = `http://127.0.0.1:${address.port}`;
  return {
    runtime,
    root,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function get(root: string, path: string, user?: string | null) {
  const headers: Record<string, string> = {};
  if (user !== undefined) {
    headers['x-test-isolate'] = '1';
    if (user) headers['x-test-user'] = user;
  }
  const res = await fetch(`${root}${path}`, { headers });
  const body = (await res.json()) as { hits?: Hit[]; error?: string };
  return { status: res.status, body };
}

test('命中返回短摘录而不是整段消息 [AC:message-body-search#AC-1]', async () => {
  const app = await boot();
  try {
    const filler = '甲'.repeat(400);
    const text = `${filler} 合同编号 UNIQUE-NEEDLE ${filler}`;
    const session = app.runtime.createChatSession({ title: '采购复盘', agentId: 'general' });
    const message = app.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
    app.runtime.store.appendMessage(session.id, 'assistant', [
      { type: 'reasoning', text: '只在推理里出现 REASON-ONLY' }
    ]);
    app.runtime.store.appendMessage(session.id, 'assistant', [
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'bash',
        input: { cmd: 'TOOL-ARG-ONLY' }
      }
    ]);
    const tool = app.runtime.store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'call-1', name: 'bash', content: '日志里有 TOOL-BODY-HIT', ok: true }
    ]);

    const found = await get(app.root, '/api/search/messages?q=unique-needle');
    assert.equal(found.status, 200);
    assert.equal(found.body.hits?.length, 1);
    const hit = found.body.hits?.[0];
    assert.ok(hit);
    assert.deepEqual(Object.keys(hit).sort(), HIT_KEYS);
    assert.equal(hit.sessionId, session.id);
    assert.equal(hit.messageId, message.id);
    assert.equal(hit.role, 'user');
    assert.equal(hit.sessionTitle, '采购复盘');
    assert.equal(hit.agentId, 'general');
    assert.match(hit.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(hit.snippet, /UNIQUE-NEEDLE/);
    assert.ok(hit.snippet.length < text.length);
    assert.equal(JSON.stringify(found.body).includes(text), false);

    const toolHit = await get(app.root, '/api/search/messages?q=' + encodeURIComponent('TOOL-BODY-HIT'));
    assert.equal(toolHit.body.hits?.length, 1);
    assert.equal(toolHit.body.hits?.[0]?.messageId, tool.id);
    assert.equal(toolHit.body.hits?.[0]?.role, 'tool');
    assert.match(toolHit.body.hits?.[0]?.snippet ?? '', /TOOL-BODY-HIT/);

    const reasoning = await get(app.root, '/api/search/messages?q=REASON-ONLY');
    assert.deepEqual(reasoning.body.hits, []);
    const arg = await get(app.root, '/api/search/messages?q=TOOL-ARG-ONLY');
    assert.deepEqual(arg.body.hits, []);
  } finally {
    await app.close();
  }
});

test('空白搜索词返回空列表且不读消息表 [AC:message-body-search#AC-2]', async () => {
  let calls = 0;
  const db: MessageSearchDb = {
    prepare() {
      calls += 1;
      throw new Error('should not scan session_messages');
    }
  };
  const sessions = [{ id: 's1', title: '有消息', agentId: 'general' }];
  assert.deepEqual(searchSessionMessageBodies(db, sessions, '', 20), []);
  assert.deepEqual(searchSessionMessageBodies(db, sessions, '   \n\t', 20), []);
  assert.deepEqual(searchSessionMessageBodies(db, [], 'hello', 20), []);
  assert.equal(calls, 0);

  const app = await boot();
  try {
    const session = app.runtime.createChatSession({ title: '已有正文', agentId: 'general' });
    app.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: '不要被空白搜索扫出来' }]);
    const missing = await get(app.root, '/api/search/messages');
    const blank = await get(app.root, '/api/search/messages?q=' + encodeURIComponent('  \t'));
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body.hits, []);
    assert.deepEqual(blank.body.hits, []);
  } finally {
    await app.close();
  }
});

test('条数默认 20、最大 50 [AC:message-body-search#AC-3]', async () => {
  assert.equal(parseMessageSearchLimit(undefined), 20);
  assert.equal(parseMessageSearchLimit(null), 20);
  assert.equal(parseMessageSearchLimit(''), 20);
  assert.equal(parseMessageSearchLimit('0'), 20);
  assert.equal(parseMessageSearchLimit('nope'), 20);
  assert.equal(parseMessageSearchLimit('100'), 50);
  assert.equal(parseMessageSearchLimit('7'), 7);

  const app = await boot();
  try {
    const session = app.runtime.createChatSession({ title: '很多命中', agentId: 'general' });
    for (let i = 0; i < 51; i += 1) {
      app.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: `第 ${i} 条 BODY-LIMIT-TOKEN` }]);
    }
    app.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: '这条没有关键词' }]);
    const def = await get(app.root, '/api/search/messages?q=BODY-LIMIT-TOKEN');
    const capped = await get(app.root, '/api/search/messages?q=BODY-LIMIT-TOKEN&limit=100');
    const one = await get(app.root, '/api/search/messages?q=BODY-LIMIT-TOKEN&limit=1');
    assert.equal(def.body.hits?.length, 20);
    assert.equal(capped.body.hits?.length, 50);
    assert.equal(one.body.hits?.length, 1);
    for (const hit of [...(def.body.hits ?? []), ...(capped.body.hits ?? [])]) {
      assert.match(hit.snippet, /BODY-LIMIT-TOKEN/);
    }
  } finally {
    await app.close();
  }
});

test('其他用户和不可见会话的消息不会返回 [AC:message-body-search#AC-4]', async () => {
  const app = await boot();
  try {
    const alice = app.runtime.createChatSession({
      title: 'Alice 的会话',
      agentId: 'general',
      metadata: { userId: 'alice' }
    });
    const bob = app.runtime.createChatSession({
      title: 'BOB-SECRET-TITLE',
      agentId: 'general',
      metadata: { userId: 'bob' }
    });
    const orphan = app.runtime.createChatSession({
      title: '没有主人',
      agentId: 'general',
      metadata: {}
    });
    app.runtime.store.appendMessage(alice.id, 'user', [{ type: 'text', text: 'SHARED-VISIBILITY-TOKEN 只属于 alice' }]);
    app.runtime.store.appendMessage(bob.id, 'assistant', [{ type: 'text', text: 'SHARED-VISIBILITY-TOKEN 只属于 bob' }]);
    app.runtime.store.appendMessage(orphan.id, 'user', [{ type: 'text', text: 'SHARED-VISIBILITY-TOKEN 孤儿会话' }]);

    const asAlice = await get(app.root, '/api/search/messages?q=SHARED-VISIBILITY-TOKEN', 'alice');
    assert.equal(asAlice.status, 200);
    assert.equal(asAlice.body.hits?.length, 1);
    assert.equal(asAlice.body.hits?.[0]?.sessionId, alice.id);
    assert.match(asAlice.body.hits?.[0]?.snippet ?? '', /alice/);
    const aliceText = JSON.stringify(asAlice.body);
    assert.equal(aliceText.includes(bob.id), false);
    assert.equal(aliceText.includes(orphan.id), false);
    assert.equal(aliceText.includes('BOB-SECRET-TITLE'), false);
    assert.equal(aliceText.includes('只属于 bob'), false);

    const asBob = await get(app.root, '/api/search/messages?q=SHARED-VISIBILITY-TOKEN', 'bob');
    assert.equal(asBob.body.hits?.length, 1);
    assert.equal(asBob.body.hits?.[0]?.sessionId, bob.id);
    assert.equal(JSON.stringify(asBob.body).includes(alice.id), false);

    const anon = await get(app.root, '/api/search/messages?q=SHARED-VISIBILITY-TOKEN', null);
    assert.equal(anon.status, 401);
  } finally {
    await app.close();
  }
});

test('只匹配消息正文，不匹配标题或智能体 [AC:message-body-search#AC-5]', async () => {
  const app = await boot();
  try {
    const session = app.runtime.createChatSession({ title: 'META-ONLY-ZEBRA', agentId: 'zebra-agent' });
    app.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: '正文里只有你好' }]);
    const byTitle = await get(app.root, '/api/search/messages?q=META-ONLY-ZEBRA');
    const byAgent = await get(app.root, '/api/search/messages?q=zebra-agent');
    const byBody = await get(app.root, '/api/search/messages?q=' + encodeURIComponent('你好'));
    assert.deepEqual(byTitle.body.hits, []);
    assert.deepEqual(byAgent.body.hits, []);
    assert.equal(byBody.body.hits?.length, 1);
    assert.equal(byBody.body.hits?.[0]?.sessionId, session.id);

    const listed = filterSessionsByQuery(
      [{ id: session.id, title: session.title, agentId: session.agentId, status: session.status, mode: session.mode }],
      'META-ONLY-ZEBRA'
    );
    assert.equal(listed.length, 1);
  } finally {
    await app.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { sessionRecapRoutes } from '../dist/routes/session-recap.js';

function listen(runtime: RawAgentRuntime): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  }).addAll(sessionRecapRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then((found) => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const { promise, resolve } = Promise.withResolvers<{ port: number; close: () => Promise<void> }>();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    resolve({
      port: address.port,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        return closed.promise;
      }
    });
  });
  return promise;
}

test('Bot 正在回复时回顾不调用模型，只返回已有回顾或空文本 [AC:session-recap#AC-7]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-running-'));
  let calls = 0;
  let folds = 0;
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'recap-running',
      async summarizeMessages() { return ''; },
      async completeText() { calls += 1; return '不该写'; },
      async runTurn() { return { stopReason: 'end' as const, assistantParts: [] }; }
    }
  });
  const fold = runtime.store.foldMessages.bind(runtime.store);
  runtime.store.foldMessages = ((sessionId: string) => {
    folds += 1;
    return fold(sessionId);
  }) as typeof runtime.store.foldMessages;
  const server = await listen(runtime);
  try {
    const bot = runtime.createBot({ name: 'Recap bot' });
    const sessionId = runtime.openBot(bot.id).sessionId;
    runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text: '先看天气' }]);
    runtime.store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: '晴' }]);
    const before = runtime.store.listMessages(sessionId).length;
    const current = runtime.getSession(sessionId)!;
    runtime.store.updateSession(sessionId, {
      status: 'running',
      metadata: {
        ...current.metadata,
        sessionRecap: { anchorId: 'kept', locale: 'zh', text: '已经看到晴', asOfDate: '2026-10-27', hint: '带伞' }
      }
    });
    const stored = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionId}/recap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'zh' })
    });
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), { text: '已经看到晴', anchorId: 'kept', hint: '带伞' });
    assert.equal(calls, 0);
    assert.equal(folds, 0);
    assert.equal(runtime.store.listMessages(sessionId).length, before);

    const emptyId = runtime.openBot(runtime.createBot({ name: 'Empty recap' }).id).sessionId;
    runtime.store.appendMessage(emptyId, 'user', [{ type: 'text', text: '还没写完' }]);
    runtime.store.updateSession(emptyId, { status: 'running' });
    const emptyBefore = runtime.store.listMessages(emptyId).length;
    const empty = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${emptyId}/recap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'zh' })
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { text: '', anchorId: null, hint: '' });
    assert.equal(calls, 0);
    assert.equal(folds, 0);
    assert.equal(runtime.store.listMessages(emptyId).length, emptyBefore);
  } finally {
    await server.close();
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端取消会停掉回顾的模型调用 [AC:session-recap#AC-8]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recap-abort-'));
  let seen: AbortSignal | undefined;
  const entered = Promise.withResolvers<void>();
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'recap-abort',
      async summarizeMessages() { return ''; },
      async completeText(input: { signal?: AbortSignal }) {
        seen = input.signal;
        entered.resolve();
        await new Promise((_resolve, reject) => {
          const signal = input.signal;
          if (!signal) {
            reject(new Error('missing signal'));
            return;
          }
          const fail = () => reject(new DOMException('aborted', 'AbortError'));
          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail, { once: true });
        });
        return 'late';
      },
      async runTurn() { return { stopReason: 'end' as const, assistantParts: [] }; }
    }
  });
  const server = await listen(runtime);
  try {
    const bot = runtime.createBot({ name: 'Abort recap' });
    const sessionId = runtime.openBot(bot.id).sessionId;
    runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text: '把支付改完' }]);
    runtime.store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: '支付页还差日期' }]);
    runtime.store.updateSession(sessionId, { status: 'idle' });
    const before = runtime.store.listMessages(sessionId).length;
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionId}/recap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: 'zh' }),
      signal: controller.signal
    });
    await entered.promise;
    const started = Date.now();
    controller.abort();
    await pending.catch(() => undefined);
    assert.ok(seen);
    assert.equal(seen.aborted, true);
    assert.notEqual((seen.reason as { name?: string } | undefined)?.name, 'TimeoutError');
    assert.ok(Date.now() - started < 5_000);
    assert.equal(runtime.store.listMessages(sessionId).length, before);
  } finally {
    await server.close();
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

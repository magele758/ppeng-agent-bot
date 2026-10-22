import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  httpStatusFromError,
  NotFoundError,
  RawAgentRuntime,
  ResourceOwnerStore,
  writeInputSuggestionSettings
} from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { cancelInputSuggestion, inputSuggestionRoutes } from '../dist/routes/input-suggestion.js';
import type { RequestAuth } from '@ppeng/agent-core';

function dispatchSuggestion(
  router: Router,
  request: IncomingMessage,
  response: ServerResponse,
  auth?: RequestAuth
): Promise<void> {
  return router
    .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), auth)
    .then((found) => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    })
    .catch((error: unknown) => {
      const status = error instanceof NotFoundError ? 404 : httpStatusFromError(error);
      response.statusCode = status;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
}

test('回复结束后才生成下一句建议，关闭开关后不再生成，后到的旧请求不能覆盖新请求 [AC:bot-input-suggestion#AC-2] [AC:bot-input-suggestion#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-suggestion-http-'));
  const calls: string[] = [];
  const aborted: boolean[] = [];
  let releaseSecond: () => void = () => undefined;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'suggestion-http',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      },
      async completeText(input: { user: string; signal?: AbortSignal }) {
        const n = calls.push(input.user);
        const signal = input.signal;
        if (n === 1) {
          await Promise.race([
            secondGate,
            new Promise<void>((resolve) => {
              if (!signal) return;
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            })
          ]);
          aborted.push(Boolean(signal?.aborted));
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          return JSON.stringify({ suggestions: ['旧建议，不应显示'] });
        }
        return JSON.stringify({ suggestions: ['把失败原因再说细一点', '换成查数据库'] });
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  }).addAll(inputSuggestionRoutes(runtime));
  const server = createServer((request, response) => {
    const isolate = request.headers['x-test-isolate'] === '1';
    const userId = request.headers['x-test-user'];
    const auth = isolate
      ? {
          isolate: true,
          labProxy: true,
          admin: false,
          user: { id: String(userId || 'bob'), tenantId: 't', email: 'bob@example.test' }
        }
      : undefined;
    void dispatchSuggestion(router, request, response, auth);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const settings = await fetch(`${root}/api/input-suggestion/settings`);
    assert.equal(settings.status, 200);
    const initial = (await settings.json()) as { settings: { enabled: boolean }; effective: { source: string } };
    assert.equal(initial.settings.enabled, true);
    assert.equal(initial.effective.source, 'default');

    const bot = runtime.createBot({ name: 'Suggestion bot' });
    const sessionId = runtime.openBot(bot.id).sessionId;
    runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text: '登录失败了' }]);
    const suggest = (requestId: number) =>
      new Promise<{ suggestion: { primary: string; alternatives?: string[] } | null; requestId?: number; enabled?: boolean }>(
        (resolve, reject) => {
          const payload = JSON.stringify({ requestId });
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port: address.port,
              path: `/api/sessions/${sessionId}/input-suggestion`,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
              }
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              res.on('end', () => {
                resolve(JSON.parse(Buffer.concat(chunks).toString()) as {
                  suggestion: { primary: string; alternatives?: string[] } | null;
                  requestId?: number;
                  enabled?: boolean;
                });
              });
            }
          );
          req.on('error', reject);
          req.end(payload);
        }
      );

    const beforeReply = await suggest(0);
    assert.equal(beforeReply.suggestion, null, '助手还没回复时不生成');

    runtime.store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: '看起来是密码错误。' }]);
    const first = suggest(1);
    const secondPromise = suggest(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseSecond();
    const bodies = await Promise.all([first, secondPromise]);
    const winner = bodies.find((body) => body.requestId === 2);
    const loser = bodies.find((body) => body.requestId === 1);
    assert.ok(winner && loser, JSON.stringify(bodies));
    assert.equal(winner.suggestion?.primary, '把失败原因再说细一点');
    assert.deepEqual(winner.suggestion?.alternatives, ['换成查数据库']);
    assert.equal(loser.suggestion, null, '被新请求覆盖的旧响应不再带建议');
    assert.equal(aborted[0], true, '新请求会取消同一会话上还在跑的旧调用');

    const plain = runtime.createChatSession({ title: 'not a bot', agentId: 'general' });
    runtime.store.appendMessage(plain.id, 'assistant', [{ type: 'text', text: 'hello' }]);
    const skipped = await fetch(`${root}/api/sessions/${plain.id}/input-suggestion`, { method: 'POST' });
    assert.equal(((await skipped.json()) as { suggestion: unknown }).suggestion, null);

    const saved = await fetch(`${root}/api/input-suggestion/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { effective: { enabled: boolean; source: string } }).effective.enabled, false);
    const disabled = await suggest(3);
    assert.equal(disabled.suggestion, null);
    assert.equal(disabled.enabled, false);

    const owned = runtime.openBot(bot.id, { userId: 'alice' });
    runtime.store.appendMessage(owned.sessionId, 'user', [{ type: 'text', text: '只有 alice 看得到' }]);
    runtime.store.appendMessage(owned.sessionId, 'assistant', [{ type: 'text', text: '收到。' }]);
    const stranger = await fetch(`${root}/api/sessions/${owned.sessionId}/input-suggestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-isolate': '1',
        'x-test-user': 'bob'
      },
      body: JSON.stringify({ requestId: 9 })
    });
    assert.equal(stranger.status, 404, '隔离模式下别的用户不能拿这个会话打模型');
    const strangerBody = (await stranger.json()) as { error?: string; suggestion?: unknown };
    assert.equal(strangerBody.suggestion, undefined);
    assert.match(strangerBody.error ?? '', /not found/i);
    assert.equal(calls.length, 2, '被拒绝的请求不能打到模型');

    writeInputSuggestionSettings(runtime.store, { enabled: true });
    const pending = suggest(4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 3, '会话还在时会发起建议调用');
    cancelInputSuggestion(sessionId);
    const cancelled = await pending;
    assert.equal(cancelled.suggestion, null, '会话结束后不再返回这次建议');
    assert.equal(aborted.at(-1), true, '会话结束后进行中的建议调用被取消');
    cancelInputSuggestion(sessionId);
    const quiet = await suggest(5);
    assert.equal(quiet.suggestion?.primary, '把失败原因再说细一点', '取消后槽位已清，同会话可以再请求');
  } finally {
    releaseSecond();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

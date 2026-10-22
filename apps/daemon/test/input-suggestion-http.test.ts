import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { inputSuggestionRoutes } from '../dist/routes/input-suggestion.js';

test('回复结束后才生成下一句建议，关闭开关后不再生成，后到的旧请求不能覆盖新请求 [AC:bot-input-suggestion#AC-2] [AC:bot-input-suggestion#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'input-suggestion-http-'));
  const calls: string[] = [];
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
      async completeText(input: { user: string }) {
        const n = calls.push(input.user);
        if (n === 1) {
          await secondGate;
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
    void router
      .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'))
      .then((found) => {
        if (!found) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch((error) => {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: String(error) }));
      });
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
  } finally {
    releaseSecond();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotGoalService, RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { botGoalsRoutes } from '../dist/routes/bot-goals.js';

test('another chat of the same Bot does not contribute goals to this chat [AC:bot-goals-panel-rules#AC-8]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-goals-panel-rules-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'panel-rules-test',
      async runTurn() { return { stopReason: 'end', assistantParts: [] }; },
      async summarizeMessages() { return ''; },
    },
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  }).addAll(botGoalsRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then((found) => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch((error) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const bot = runtime.createBot({ name: 'Two chats' });
    const currentId = runtime.openBot(bot.id).sessionId;
    const other = runtime.store.createSession({
      title: 'Other chat',
      mode: 'chat',
      agentId: bot.id,
      metadata: { botId: bot.id, canonicalBotChat: true },
    });
    const current = new BotGoalService(runtime.store, Date.now, currentId);
    const elsewhere = new BotGoalService(runtime.store, Date.now, other.id);
    current.create({ botId: bot.id, sessionId: currentId, title: '当前这场', objective: '把登录失败提示改成中文，完成结果是用户看到中文错误' });
    elsewhere.create({ botId: bot.id, sessionId: other.id, title: '另一场', objective: '把退出按钮移到页面右上角，完成结果是按钮出现在右上角' });
    const base = `${root}/api/bots/${bot.id}/goals`;
    const listedCurrent = await (await fetch(`${base}?sessionId=${encodeURIComponent(currentId)}`)).json();
    const listedOther = await (await fetch(`${base}?sessionId=${encodeURIComponent(other.id)}`)).json();
    assert.deepEqual(listedCurrent.goals.map((goal: { title: string }) => goal.title), ['当前这场']);
    assert.deepEqual(listedOther.goals.map((goal: { title: string }) => goal.title), ['另一场']);
    assert.equal(JSON.stringify(listedCurrent).includes('另一场'), false);
    assert.equal(JSON.stringify(listedOther).includes('当前这场'), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

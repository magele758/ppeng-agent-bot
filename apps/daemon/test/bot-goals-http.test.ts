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

test('Lab goal HTTP contract saves preferences and controls only the selected goal [AC:bot-multi-goal-coordination#AC-14]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-goals-http-'));
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'http-goals-test', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; }
  } });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
  }).addAll(botGoalsRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then(found => {
      if (!found) { response.statusCode = 404; response.end(); }
    }).catch(error => { response.statusCode = 400; response.end(JSON.stringify({ error: String(error) })); });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const bot = runtime.createBot({ name: 'HTTP goals' });
    const sessionId = runtime.openBot(bot.id).sessionId;
    const service = new BotGoalService(runtime.store, Date.now, sessionId);
    const first = service.create({ botId: bot.id, sessionId, title: 'Login', objective: 'Repair login' });
    const second = service.create({ botId: bot.id, sessionId, title: 'Deploy', objective: 'Watch deployment' });
    const base = `${root}/api/bots/${bot.id}/goals`;
    const saved = await fetch(`${base}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, maxConcurrent: 2, defaultBudgetUsd: 12, preferredStrategy: 'subagent' }) });
    assert.equal(saved.status, 200);
    const reread = await fetch(`${base}?sessionId=${sessionId}`);
    const snapshot = await reread.json();
    assert.equal(snapshot.settings.maxConcurrent, 2);
    assert.equal(snapshot.settings.preferredStrategy, 'subagent');
    assert.equal(snapshot.settings.defaultBudgetUsd, 12);
    assert.equal(snapshot.goals.length, 2);
    const third = service.create({ botId: bot.id, sessionId, title: 'New task', objective: 'Next work' });
    assert.equal(third.budgetUsd, 12);
    for (const action of ['pause', 'resume', 'reprioritize', 'cancel']) {
      const response = await fetch(`${base}/${first.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, action, priority: 5 }) });
      assert.equal(response.status, 200, action);
      const body = await response.json();
      if (action === 'reprioritize') assert.equal(body.goal.priority, 5);
      else assert.equal(body.goal.status, { pause: 'paused', resume: 'queued', cancel: 'cancelled' }[action]);
      assert.equal(service.get(bot.id, second.id)?.status, 'queued');
    }
    assert.equal((await fetch(base)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

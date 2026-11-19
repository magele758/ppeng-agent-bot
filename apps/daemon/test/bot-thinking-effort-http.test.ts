import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { thinkingEffortRoutes } from '../dist/routes/thinking-effort.js';
import { botsRoutes } from '../dist/routes/bots.js';
import { sessionsRoutes } from '../dist/routes/sessions.js';

test('per-bot thinking effort pins over PATCH /api/bots/:id and follows global when cleared [AC:bot-thinking-effort#AC-1] [AC:bot-thinking-effort#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-thinking-effort-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'bot-effort-http',
      async runTurn() {
        return { stopReason: 'end' as const, assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      return text ? JSON.parse(text) : {};
    }
  }).addAll(botsRoutes(runtime)).addAll(sessionsRoutes(runtime)).addAll(thinkingEffortRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then(found => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch(error => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const root = `http://127.0.0.1:${address.port}`;
    const bot = runtime.createBot({ name: 'Effort HTTP Bot' });
    const patchBot = async (body: unknown) => fetch(`${root}/api/bots/${encodeURIComponent(bot.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert.equal((await patchBot({ thinkingEffort: 'low' })).status, 200);
    const savedPatch = await (await patchBot({ description: 'read back' })).json();
    assert.equal(savedPatch.thinkingEffort, 'low');
    const canonical = runtime.getSession(bot.canonicalSessionId);
    assert.equal(canonical?.metadata?.thinkingEffort, 'low');

    const offPatch = await patchBot({ thinkingEffort: 'off' });
    assert.equal(offPatch.status, 200);
    assert.equal((await offPatch.json()).thinkingEffort, 'off');
    assert.equal(runtime.getSession(bot.canonicalSessionId)?.metadata?.thinkingEffort, 'off');

    assert.equal((await patchBot({ thinkingEffort: 'turbo' })).status, 400);
    assert.equal((await patchBot({ thinkingEffort: 'max', description: 'not saved' })).status, 400);
    assert.equal(runtime.getSession(bot.canonicalSessionId)?.metadata?.thinkingEffort, 'off');
    assert.equal(runtime.getBot(bot.id).description, 'read back');

    assert.equal((await patchBot({ thinkingEffort: null })).status, 200);
    assert.ok(!('thinkingEffort' in (runtime.getSession(bot.canonicalSessionId)?.metadata ?? {})));
    const cleared = await (await patchBot({ description: 'read back again' })).json();
    assert.equal(cleared.thinkingEffort, null);

    // Opening a bot chat can hand the pin through session metadata, same rule as modelOverride.
    const opened = await (await fetch(`${root}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.id, metadata: { thinkingEffort: 'high' } })
    })).json();
    assert.equal(opened.session?.metadata?.thinkingEffort, 'high');
    assert.equal(runtime.getSession(bot.canonicalSessionId)?.metadata?.thinkingEffort, 'high');
    const rejected = await fetch(`${root}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botId: bot.id, metadata: { thinkingEffort: 'turbo' } })
    });
    assert.equal(rejected.status, 400);
    assert.equal(runtime.getSession(bot.canonicalSessionId)?.metadata?.thinkingEffort, 'high');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('global thinking effort settings keep working next to per-bot pins [AC:bot-thinking-effort#AC-6]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-effort-global-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'bot-effort-global-http',
      async runTurn() {
        return { stopReason: 'end' as const, assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      return text ? JSON.parse(text) : {};
    }
  }).addAll(botsRoutes(runtime)).addAll(thinkingEffortRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then(found => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch(error => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/thinking-effort/settings`;
    const read = async () => (await (await fetch(base)).json()) as {
      settings: { level: string };
      effective: { level: string; source: string };
    };
    const write = async (level: unknown) => fetch(base, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level })
    });

    const fresh = await read();
    assert.equal(fresh.settings.level, 'off');
    assert.equal(fresh.effective.source, 'default');

    assert.equal((await write('low')).status, 200);
    const saved = await read();
    assert.equal(saved.settings.level, 'low');
    assert.equal(saved.effective.source, 'ui');

    assert.equal((await write('off')).status, 200);
    assert.equal((await read()).settings.level, 'off');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

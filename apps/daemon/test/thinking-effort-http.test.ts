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

test('thinking effort saves in behavior settings and stays after reload [AC:thinking-effort#AC-1] [AC:thinking-effort#AC-2] [AC:thinking-effort#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thinking-effort-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'thinking-effort-http',
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
  }).addAll(thinkingEffortRoutes(runtime));
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
    const url = `http://127.0.0.1:${address.port}/api/thinking-effort/settings`;
    const read = async () => (await (await fetch(url)).json()) as {
      settings: { level: string };
      effective: { level: string; source: string };
    };
    const write = async (level: unknown) => fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level })
    });

    const fresh = await read();
    assert.equal(fresh.settings.level, 'off');
    assert.equal(fresh.effective.source, 'default');

    for (const level of ['low', 'medium', 'high']) {
      assert.equal((await write(level)).status, 200);
      const saved = await read();
      assert.equal(saved.settings.level, level);
      assert.equal(saved.effective.level, level);
      assert.equal(saved.effective.source, 'ui');
    }

    assert.equal((await write('max')).status, 400);
    assert.equal((await read()).settings.level, 'high');

    assert.equal((await write('off')).status, 200);
    const closed = await read();
    assert.equal(closed.settings.level, 'off');
    assert.equal(closed.effective.source, 'ui');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

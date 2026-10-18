import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ANONYMOUS_AUTH, resolveBotPrincipal, readModelCatalog, upsertProvider } from '@ppeng/agent-core';
import { modelProviderRoutes } from '../../apps/daemon/dist/routes/model-providers.js';
import { sessionsRoutes } from '../../apps/daemon/dist/routes/sessions.js';

async function call(rt, routes, method, pattern, body = {}, params = {}) {
  const route = routes(rt).find((r) => r.method === method && r.pattern === pattern);
  assert.ok(route);
  let output;
  const response = { statusCode: 200, setHeader() {}, end(raw) { output = { status: this.statusCode, body: JSON.parse(raw) }; } };
  await route.handler({ request: { method, headers: {} }, response, auth: ANONYMOUS_AUTH, url: new URL(`http://localhost${pattern}`), parts: [], params, requireParam: (name) => params[name], readBody: async () => body });
  return output;
}

test('HTTP global default hot switches outgoing requests and rejects stale selections atomically [AC:global-default-model-clarity#AC-2] [AC:global-default-model-clarity#AC-3] [AC:global-default-model-clarity#AC-6]', async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body.model);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'test-response', choices: [{ message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'global-default-wire-'));
  const rt = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: { name: 'no-network-fallback', async runTurn() { throw new Error('Unexpected fallback'); } } });
  try {
    const p = upsertProvider(rt.store, { name: 'Local probe', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-test-key', useJsonMode: false, models: [{ id: 'first', enabled: true }, { id: 'second', enabled: true }, { id: 'disabled', enabled: false }] });
    const ref = (modelId) => ({ providerId: p.id, modelId });
    const setDefault = (modelId) => call(rt, modelProviderRoutes, 'PATCH', '/api/model-providers/default', { defaultRef: ref(modelId) });
    const created = await call(rt, sessionsRoutes, 'POST', '/api/sessions', { title: 'Follows default', agentId: 'general' });
    const sid = created.body.session.id;
    const run = async (id, expected) => {
      rt.store.appendMessage(id, 'user', [{ type: 'text', text: 'Reply briefly.' }]);
      const before = calls.length;
      await rt.runSession(id);
      assert.ok(calls.length > before, 'request reached the local HTTP upstream');
      assert.equal(calls.at(-1), expected);
    };
    await run(sid, 'first');
    for (const invalid of ['disabled', 'deleted']) {
      await assert.rejects(setDefault(invalid), /available|enabled/);
      assert.deepEqual(readModelCatalog(rt.store).defaultRef, ref('first'));
    }
    await setDefault('second');
    await run(sid, 'second');
    await call(rt, sessionsRoutes, 'PATCH', '/api/sessions/:id', { modelRef: ref('first') }, { id: sid });
    await run(sid, 'first');
    await call(rt, sessionsRoutes, 'PATCH', '/api/sessions/:id', { modelRef: null }, { id: sid });
    await run(sid, 'second');
    const bot = rt.createBot({ name: 'Default follower' });
    await run(bot.canonicalSessionId, 'second');
    rt.updateBot(bot.id, { modelOverride: ref('first') });
    await run(bot.canonicalSessionId, 'first');
    rt.updateBot(bot.id, { modelOverride: null });
    await run(bot.canonicalSessionId, 'second');
    const principal = resolveBotPrincipal(rt.store);
    const room = rt.rooms.create(principal, { title: 'Wire test', botIds: [bot.id] });
    const runRoom = async (expected) => {
      const before = calls.length;
      rt.rooms.send(principal, room.id, { text: 'Reply briefly.' });
      await rt.rooms.tick();
      assert.ok(calls.length > before, 'room request reached upstream');
      assert.equal(calls.at(-1), expected);
    };
    await runRoom('second');
    await setDefault('first');
    await runRoom('first');
    assert.deepEqual(readModelCatalog(rt.store).defaultRef, ref('first'));
  } finally {
    await rt.destroy();
    await new Promise((resolve) => server.close(resolve));
    // Runtime trace writes outlive destroy(); let the OS reclaim this temporary directory.
  }
});

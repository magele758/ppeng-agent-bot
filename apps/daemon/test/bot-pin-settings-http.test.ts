import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotGoalService, RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { botPinSettingsRoutes } from '../dist/routes/bot-pin-settings.js';

test('pin HTTP persistence and migration [AC:bot-pin-sync#AC-1] [AC:bot-pin-sync#AC-2]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-goals-http-'));
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'http-goals-test', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; }
  } });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
  }).addAll(botPinSettingsRoutes(runtime));
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
    const base = `${root}/api/bot-pin-settings`;
    const read = async () => (await (await fetch(base)).json()).state;
    const write = async (state, initialize = false) => fetch(base, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({state,initialize})});
    assert.equal(await read(), null);
    const state = {customized:true, ids:['rsi'], roomIds:[]};
    assert.equal((await write(state,true)).status,200);
    assert.deepEqual(await read(),state);
    const empty = {...state,ids:[]};
    assert.equal((await write(empty)).status,200);
    await write(state,true);
    assert.deepEqual(await read(),empty);
    assert.equal((await write({ids:[]})).status,400);
    assert.deepEqual(await read(),empty);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

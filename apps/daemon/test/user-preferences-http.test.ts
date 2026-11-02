import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotGoalService, RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { userPreferenceRoutes } from '../dist/routes/user-preferences.js';

test('durable preferences HTTP migration [AC:user-preference-sync#AC-1] [AC:user-preference-sync#AC-2]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-goals-http-'));
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
    name: 'http-goals-test', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; }
  } });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); }
  }).addAll(userPreferenceRoutes(runtime));
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
    const base = `${root}/api/user/preferences`;
    const read = async () => (await (await fetch(base)).json()).values;
    const write = async (values, initialize = false) => fetch(base, {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({values,initialize})});
    assert.deepEqual(await read(), {});
    assert.equal((await write({'theme':'dark','lab.locale':'zh'},true)).status,200);
    assert.equal((await write({'theme':null})).status,200);
    await write({'theme':'light','lab.fontSize':'18'},true);
    assert.deepEqual(await read(),{'theme':null,'lab.locale':'zh','lab.fontSize':'18'});
    assert.equal((await write({'token':'no'})).status,400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preference records are isolated by authenticated user [AC:user-preference-sync#AC-3]',async()=>{
 const data = new Map();
 const runtime = {store:{getDaemonControl:key=>data.get(key),setDaemonControl:(key,value)=>data.set(key,value)}};
 const routes = userPreferenceRoutes(runtime);
 const write = async (id,values) => {
  const response={setHeader(){},writeHead(){},end(){}};
  await routes[1].handler({auth:{user:{id,tenantId:'tenant'}},response,readBody:async()=>({values})});
 };
 await write('a',{'theme':'dark'});
 await write('b',{'theme':'light'});
 assert.equal(data.size,2);
 assert.deepEqual([...data.values()],[{'theme':'dark'},{'theme':'light'}]);
});

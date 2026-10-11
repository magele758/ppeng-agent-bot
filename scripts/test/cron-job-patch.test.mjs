/**
 * PATCH /api/cron/jobs/:id copies the fields the Lab sends, including precheck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '@ppeng/agent-core';
import { cronRoutes } from '../../apps/daemon/dist/routes/cron.js';

function makeRuntime() {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'cron-route-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'cron-route-state-'))
  });
}

async function call(runtime, method, pattern, params, body) {
  const route = cronRoutes(runtime).find((item) => item.method === method && item.pattern === pattern);
  assert.ok(route, `${method} ${pattern}`);
  const out = { status: 200, body: undefined };
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      out.status = this.statusCode;
      out.body = text ? JSON.parse(String(text)) : undefined;
    }
  };
  await route.handler({
    request: { method, headers: {} },
    response,
    url: new URL('http://x/api/cron/jobs'),
    parts: [],
    params,
    requireParam: (name) => params[name],
    readBody: async () => body,
    auth: { user: null }
  });
  return out;
}

test('PATCH /api/cron/jobs/:id 写入名称、提示、时刻、开关和预检 [AC:bot-gateway-delivery#AC-6]', async () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'cron', message: 'seed', background: false });
  const created = rt.createCronJob({
    name: 'brief',
    prompt: 'summarize',
    cron: '0 9 * * *',
    sessionId: session.id,
    enabled: true
  });

  const patched = await call(rt, 'PATCH', '/api/cron/jobs/:id', { id: created.id }, {
    name: 'evening',
    prompt: 'wrap up',
    cron: '0 18 * * *',
    enabled: false,
    precheck: { kind: 'predicate', source: 'wakeAgent: false' }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.name, 'evening');
  assert.equal(patched.body.job.prompt, 'wrap up');
  assert.equal(patched.body.job.scheduleValue, '0 18 * * *');
  assert.equal(patched.body.job.enabled, false);
  assert.deepEqual(patched.body.job.metadata.precheck, { kind: 'predicate', source: 'wakeAgent: false' });

  const cleared = await call(rt, 'PATCH', '/api/cron/jobs/:id', { id: created.id }, { precheck: null, enabled: true });
  assert.equal(cleared.body.job.metadata.precheck, undefined);
  assert.equal(cleared.body.job.enabled, true);

  const untouched = await call(rt, 'PATCH', '/api/cron/jobs/:id', { id: created.id }, {});
  assert.equal(untouched.body.job.name, 'evening');
});

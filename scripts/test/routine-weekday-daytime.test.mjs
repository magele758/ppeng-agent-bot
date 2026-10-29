import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '@ppeng/agent-core';
import { cronRoutes } from '../../apps/daemon/dist/routes/cron.js';

function makeRuntime() {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'weekday-route-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'weekday-route-state-'))
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

function localClock(iso, timezone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  );
}

test('POST /api/cron/jobs 省略时间时默认工作日白天，写明的周末夜间保留 [AC:routine-weekday-daytime-default#AC-1] [AC:routine-weekday-daytime-default#AC-2] [AC:routine-weekday-daytime-default#AC-3]', async () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'cron', message: 'seed', background: false });
  const weekend = await call(rt, 'POST', '/api/cron/jobs', {}, {
    sessionId: session.id,
    name: 'night',
    prompt: 'watch',
    cron: '15 3 * * 0',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(weekend.status, 201);
  assert.equal(weekend.body.job.scheduleValue, '15 3 * * 0');
  const night = localClock(weekend.body.job.nextRunAt, 'Asia/Shanghai');
  assert.equal(night.hour, '03');
  assert.equal(night.weekday, 'Sun');

  const created = await call(rt, 'POST', '/api/cron/jobs', {}, {
    sessionId: session.id,
    name: 'brief',
    prompt: 'summarize',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.job.scheduleKind, 'cron5');
  assert.equal(created.body.job.scheduleValue, '0 9 * * 1-5');
  const morning = localClock(created.body.job.nextRunAt, 'Asia/Shanghai');
  assert.equal(morning.hour, '09');
  assert.equal(morning.minute, '00');
  assert.ok(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(morning.weekday), morning.weekday);

  const renamed = await call(rt, 'PATCH', '/api/cron/jobs/:id', { id: weekend.body.job.id }, { name: 'still night' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.job.scheduleValue, '15 3 * * 0');
  assert.equal(rt.getCronJob(weekend.body.job.id).scheduleValue, '15 3 * * 0');
});

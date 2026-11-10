import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsRoutes } from '../dist/routes/sessions.js';
import { botsRoutes } from '../dist/routes/bots.js';

function heavySession() {
  return {
    id: 's1',
    title: 'Long chat',
    status: 'idle',
    metadata: {
      botId: 'b1',
      taskRunMode: 'auto',
      usageCostUsd: 1.5,
      eventLog: { events: Array.from({ length: 20000 }, (_, i) => ({ seq: i, kind: 'run-log-entry' })) },
      stepCheckpoints: Array.from({ length: 3000 }, (_, i) => ({ step: i, note: 'checkpoint-entry' }))
    }
  };
}

function capture() {
  const out = { status: 0, body: '' };
  const response = {
    statusCode: 200,
    setHeader() {},
    end(value = '') {
      out.status = this.statusCode;
      out.body = value;
    }
  };
  return { out, response };
}

function assertSlim(session: { metadata: Record<string, unknown> }, body: string) {
  assert.equal(session.metadata.eventLog, undefined);
  assert.equal(session.metadata.stepCheckpoints, undefined);
  assert.equal(session.metadata.botId, 'b1');
  assert.equal(session.metadata.taskRunMode, 'auto');
  assert.equal(session.metadata.usageCostUsd, 1.5);
  assert.ok(!body.includes('run-log-entry'));
  assert.ok(!body.includes('checkpoint-entry'));
  assert.ok(body.length < 2000, `response is ${body.length} bytes`);
}

test('opening or polling a long session leaves its run logs behind [AC:lab-startup-request-load#AC-1]', async () => {
  const stored = heavySession();
  const runtime = {
    getSession: (id: string) => (id === 's1' ? stored : undefined),
    getSessionMessages: () => [],
    getLatestAssistantText: () => '',
    store: { listUnclaimedInbox: () => [], listVisibleMessagesPage: () => ({ messages: [], hasMore: false }) }
  };
  const route = sessionsRoutes(runtime).find((r) => r.method === 'GET' && r.pattern === '/api/sessions/:id');
  assert.ok(route);
  for (const query of ['?includeMessages=false', '?messageLimit=40', '']) {
    const { out, response } = capture();
    await route.handler({
      request: { headers: {} },
      response,
      url: new URL('http://local/api/sessions/s1' + query),
      params: { id: 's1' },
      requireParam: () => 's1',
      auth: {}
    });
    assert.equal(out.status, 200);
    assertSlim(JSON.parse(out.body).session, out.body);
  }
  assert.equal(stored.metadata.eventLog.events.length, 20000);
  assert.equal(stored.metadata.stepCheckpoints.length, 3000);
});

test('opening a Bot returns its chat without the run logs [AC:lab-startup-request-load#AC-2]', async () => {
  const stored = heavySession();
  const runtime = {
    openBot: () => ({ bot: { id: 'b1', name: 'Bot' }, sessionId: 's1', createdSession: false }),
    getSession: () => stored
  };
  const route = botsRoutes(runtime).find((r) => r.method === 'POST' && r.pattern === '/api/bots/:id/open');
  assert.ok(route);
  const { out, response } = capture();
  await route.handler({ request: { headers: {} }, response, requireParam: () => 'b1', auth: {} });
  assert.equal(out.status, 200);
  const data = JSON.parse(out.body);
  assert.equal(data.bot.id, 'b1');
  assertSlim(data.session, out.body);
  assert.equal(stored.metadata.eventLog.events.length, 20000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { api, pollApi, loginFailureLocksLab, loginRequiredEventLocksLab } from './api.ts';

test('draft release with login off does not lock the Lab', () => {
  assert.equal(loginFailureLocksLab(403, { error: 'human_login_required', loginRequired: false }), false);
  assert.equal(loginFailureLocksLab(401, { error: 'login_required', loginRequired: false }), false);
  assert.equal(loginRequiredEventLocksLab({ loginRequired: false }), false);
});

test('a missing session still locks the Lab when login is on', () => {
  assert.equal(loginFailureLocksLab(401, { error: 'login_required', loginRequired: true }), true);
  assert.equal(loginFailureLocksLab(401, { error: 'login_required' }), true);
  assert.equal(loginRequiredEventLocksLab(undefined), true);
  assert.equal(loginRequiredEventLocksLab({ loginRequired: true }), true);
});

function stubFetch(t: { after: (fn: () => void) => void }) {
  const calls: { path: string; method: string; release: (body: unknown) => void }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        release: (body) => resolve(new Response(JSON.stringify(body), { status: 200 }))
      });
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('a timed read joins the one still pending and asks again once it ends [AC:lab-startup-request-load#AC-3]', async (t) => {
  const calls = stubFetch(t);
  const first = pollApi('/api/coalesce-a');
  const second = pollApi('/api/coalesce-a');
  const other = pollApi('/api/coalesce-b');
  await Promise.resolve();
  assert.deepEqual(calls.map((call) => call.path), ['/api/coalesce-a', '/api/coalesce-b']);
  calls[0].release({ n: 1 });
  calls[1].release({ n: 2 });
  assert.deepEqual(await first, { n: 1 });
  assert.deepEqual(await second, { n: 1 });
  assert.deepEqual(await other, { n: 2 });

  const third = pollApi('/api/coalesce-a');
  await Promise.resolve();
  assert.equal(calls.length, 3);
  calls[2].release({ n: 3 });
  assert.deepEqual(await third, { n: 3 });
});

test('a failed timed read releases the address [AC:lab-startup-request-load#AC-3]', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let count = 0;
  globalThis.fetch = (async () => {
    count += 1;
    return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
  }) as typeof fetch;
  const [a, b] = await Promise.allSettled([pollApi('/api/coalesce-fail'), pollApi('/api/coalesce-fail')]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  assert.equal(count, 1);
  await assert.rejects(pollApi('/api/coalesce-fail'));
  assert.equal(count, 2);
});

test('a timed read after a saved change does not reuse a request sent before it [AC:lab-startup-request-load#AC-4]', async (t) => {
  const calls = stubFetch(t);
  const before = pollApi('/api/coalesce-w');
  const write = api('/api/coalesce-w', { method: 'PATCH', body: '{}' });
  const during = pollApi('/api/coalesce-w');
  await Promise.resolve();
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'PATCH', 'GET']);
  calls[1].release({ ok: true });
  await write;
  const after = pollApi('/api/coalesce-w');
  await Promise.resolve();
  assert.equal(calls.length, 4);
  calls[0].release({ v: 'old' });
  calls[2].release({ v: 'mid' });
  calls[3].release({ v: 'new' });
  assert.deepEqual(await before, { v: 'old' });
  assert.deepEqual(await during, { v: 'mid' });
  assert.deepEqual(await after, { v: 'new' });
});

test('a read that follows an event never joins a timed read already on its way [AC:lab-startup-request-load#AC-6]', async (t) => {
  const calls = stubFetch(t);
  const timed = pollApi('/api/coalesce-e');
  const afterEvent = api('/api/coalesce-e');
  const again = api('/api/coalesce-e');
  await Promise.resolve();
  assert.equal(calls.length, 3);
  calls[0].release({ v: 'stale' });
  calls[1].release({ v: 'fresh' });
  calls[2].release({ v: 'fresh' });
  assert.deepEqual(await timed, { v: 'stale' });
  assert.deepEqual(await afterEvent, { v: 'fresh' });
  assert.deepEqual(await again, { v: 'fresh' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { langfuseRoutes } from '../dist/routes/langfuse.js';
import { mirrorTraceToLangfuse } from '@ppeng/agent-core';

function fixture() {
  const values = new Map<string, unknown>();
  const store = {
    getDaemonControl: (key: string) => values.get(key),
    setDaemonControl: (key: string, value: unknown) => { values.set(key, value); }
  };
  const routes = langfuseRoutes({ store } as never);
  const call = async (method: string, path: string, body?: unknown) => {
    let text = '';
    const response = { statusCode: 0, setHeader() {}, end(chunk: string) { text = chunk; } };
    const route = routes.find(row => row.method === method && row.pattern === path)!;
    await route.handler({ response, readBody: async () => body } as never);
    assert.equal(response.statusCode, 200);
    return JSON.parse(text);
  };
  return { store, call };
}

test('settings API exposes real delivery state and connection probes stay separate [AC:langfuse-delivery-health#AC-1] [AC:langfuse-delivery-health#AC-3]', async t => {
  const { store, call } = fixture();
  const initial = await call('GET', '/api/langfuse/settings');
  assert.equal(initial.effective.source, 'default');
  assert.equal(initial.effective.delivery.attempted, 0);
  const saved = await call('PATCH', '/api/langfuse/settings', {
    enabled: true, baseUrl: 'http://langfuse.test', publicKey: 'pk-secret', secretKey: 'sk-secret'
  });
  assert.equal(saved.effective.source, 'ui');
  assert.equal(saved.effective.delivery.attempted, 0);
  const good = async () => ({ ok: true, status: 207, text: async () => '{}', json: async () => ({}) });
  await mirrorTraceToLangfuse(store, 'api-delivery', { kind: 'turn_end' }, {}, good);
  const read = await call('GET', '/api/langfuse/settings');
  assert.equal(read.effective.delivery.succeeded, 1);
  assert.ok(read.effective.delivery.lastSuccessAt);
  assert.doesNotMatch(JSON.stringify(read), /pk-secret|sk-secret/);
  t.mock.method(globalThis, 'fetch', good as never);
  assert.equal((await call('POST', '/api/langfuse/probe', {})).ok, true);
  assert.equal((await call('GET', '/api/langfuse/settings')).effective.delivery.attempted, 1);
  const changed = await call('PATCH', '/api/langfuse/settings', { baseUrl: 'http://other.test' });
  assert.equal(changed.effective.delivery.succeeded, 0);
  assert.equal(changed.effective.delivery.lastSuccessAt, null);
});

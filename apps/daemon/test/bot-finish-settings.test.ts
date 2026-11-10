import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { botFinishRoutes } from '../dist/routes/bot-finish.js';

function fixture() {
  const values = new Map<string, unknown>();
  const store = {
    getDaemonControl: <T>(key: string) => values.get(key) as T | undefined,
    setDaemonControl: (key: string, value: unknown) => { values.set(key, value); }
  };
  const routes = botFinishRoutes({ store } as never);
  const call = async (method: 'GET' | 'PATCH', body?: unknown) => {
    let text = '';
    const response = { statusCode: 0, setHeader() {}, end(chunk?: string) { text = chunk ?? ''; } };
    const route = routes.find((item) => item.method === method)!;
    await route.handler({ response, readBody: async () => body } as never);
    return { status: response.statusCode, body: JSON.parse(text) };
  };
  return { call, values };
}

test('Lab reads and saves how Bot turns are followed to the end [AC:bot-finish-follow-through#AC-15]', async () => {
  const { call, values } = fixture();
  const fresh = await call('GET');
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.settings, fresh.body.defaults);
  assert.equal(fresh.body.settings.finishCheckEnabled, true);
  assert.equal(fresh.body.settings.wakeEnabled, true);
  assert.equal(fresh.body.settings.followupAttachEnabled, true);

  const saved = await call('PATCH', { finishCheckEnabled: false, maxContinuations: 3, wakeDelayMinutes: 30 });
  assert.equal(saved.body.settings.finishCheckEnabled, false);
  assert.equal(saved.body.settings.maxContinuations, 3);
  assert.equal((await call('GET')).body.settings.wakeDelayMinutes, 30, 'the saved value is what the next read returns');
  assert.equal(values.size, 1, 'kept in the persisted settings store');

  for (const bad of [{ maxContinuations: 0 }, { maxWakes: 99 }, { wakeEnabled: 'no' }, { somethingElse: 1 }]) {
    await assert.rejects(call('PATCH', bad), /Invalid|Unknown/, JSON.stringify(bad));
  }
  assert.equal((await call('GET')).body.settings.maxContinuations, 3, 'a rejected save changes nothing');

  const policy = readFileSync(new URL('../src/access/policy.ts', import.meta.url), 'utf8');
  assert.match(policy, /\['GET \/api\/bot-finish\/settings', AUTHENTICATED\]/);
  assert.match(policy, /\['PATCH \/api\/bot-finish\/settings', ADMIN\]/);
  assert.match(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'), /botFinishRoutes\(runtime\)/);
});

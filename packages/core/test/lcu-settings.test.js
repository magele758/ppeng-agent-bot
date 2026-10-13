import test from 'node:test';
import assert from 'node:assert/strict';
import { readLcuSettings, writeLcuSettings, LCU_SETTINGS_KEY } from '../dist/computer-use/settings.js';
import { defaultLcuCommand } from '../dist/computer-use/lcu-provider.js';
import { computerUseRoutes } from '../../../apps/daemon/dist/routes/computer-use.js';

function memoryStore(initial) {
  const data = new Map(initial ? [[LCU_SETTINGS_KEY, initial]] : []);
  return {
    data,
    getDaemonControl(key) { return data.get(key); },
    setDaemonControl(key, value) { data.set(key, value); },
  };
}

function runtimeWith(store) {
  const closed = [];
  return {
    closed,
    store,
    computerUse: { close: async () => { closed.push(true); } },
  };
}

async function call(runtime, method, body) {
  const spec = computerUseRoutes(runtime).find((route) => route.method === method);
  assert.ok(spec, method);
  let status = 200;
  let payload;
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      status = this.statusCode;
      payload = text ? JSON.parse(text) : undefined;
    },
  };
  try {
    await spec.handler({
      response,
      readBody: async () => body,
    });
  } catch (error) {
    return { error };
  }
  return { status, payload };
}

test('writeLcuSettings persists a boolean switch and an absolute command', () => {
  const store = memoryStore();
  assert.deepEqual(readLcuSettings(store), { enabled: false, command: defaultLcuCommand() });

  const saved = writeLcuSettings(store, { enabled: true, command: '/usr/local/bin/lcu' });
  assert.deepEqual(saved, { enabled: true, command: '/usr/local/bin/lcu' });
  assert.deepEqual(store.data.get(LCU_SETTINGS_KEY), saved);
  assert.deepEqual(readLcuSettings(store), saved);

  const toggled = writeLcuSettings(store, { enabled: false });
  assert.equal(toggled.enabled, false);
  assert.equal(toggled.command, '/usr/local/bin/lcu');
});

test('writeLcuSettings rejects a relative command and a non-boolean switch', () => {
  const store = memoryStore({ enabled: true, command: '/usr/local/bin/lcu' });
  assert.throws(() => writeLcuSettings(store, { command: 'lcu' }), /absolute path/);
  assert.throws(() => writeLcuSettings(store, { command: 1 }), /absolute path/);
  assert.throws(() => writeLcuSettings(store, { enabled: 'yes' }), /boolean/);
  assert.deepEqual(readLcuSettings(store), { enabled: true, command: '/usr/local/bin/lcu' });
});

test('PATCH /api/computer-use/settings saves valid fields and closes desktop use when disabled', async () => {
  const runtime = runtimeWith(memoryStore());

  const enabled = await call(runtime, 'PATCH', { enabled: true, command: '/usr/local/bin/lcu' });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.payload.settings, { enabled: true, command: '/usr/local/bin/lcu' });
  assert.deepEqual(runtime.closed, []);

  const read = await call(runtime, 'GET');
  assert.deepEqual(read.payload.settings, enabled.payload.settings);

  const disabled = await call(runtime, 'PATCH', { enabled: false });
  assert.equal(disabled.payload.settings.enabled, false);
  assert.equal(disabled.payload.settings.command, '/usr/local/bin/lcu');
  assert.deepEqual(runtime.closed, [true]);
});

test('PATCH /api/computer-use/settings rejects unknown fields and invalid values', async () => {
  const runtime = runtimeWith(memoryStore({ enabled: true, command: '/usr/local/bin/lcu' }));

  for (const body of [null, [], 'nope', { enabled: true, extra: 1 }]) {
    const rejected = await call(runtime, 'PATCH', body);
    assert.equal(rejected.error?.name, 'ValidationError');
    assert.match(rejected.error.message, /Only enabled and command/);
  }

  const relative = await call(runtime, 'PATCH', { command: 'relative-command' });
  assert.equal(relative.error?.name, 'ValidationError');
  assert.match(relative.error.message, /absolute path/);

  const flag = await call(runtime, 'PATCH', { enabled: 'yes' });
  assert.equal(flag.error?.name, 'ValidationError');
  assert.match(flag.error.message, /boolean/);

  assert.deepEqual(readLcuSettings(runtime.store), { enabled: true, command: '/usr/local/bin/lcu' });
  assert.deepEqual(runtime.closed, []);
});

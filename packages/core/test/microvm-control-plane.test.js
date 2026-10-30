import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMicrovmApiKey,
  createMicrovmSandbox,
  getMicrovmGuestHealth,
  deleteMicrovmSandbox,
  smokeMicrovmLifecycle
} from '../dist/sandbox/microvm-control-plane.js';

const BASE = 'http://microvm.test:18081';
const ENV_BASE = {
  MICROVM_URL: BASE,
  MICROVM_API_KEY: 'test-api-key'
};

function jsonResponse(status, body, ok = status >= 200 && status < 300) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok,
    text: async () => raw
  };
}

test('resolveMicrovmApiKey prefers MICROVM_API_KEY then BOOTSTRAP then E2B then RAW', () => {
  assert.equal(resolveMicrovmApiKey({ MICROVM_API_KEY: ' a ', BOOTSTRAP_API_KEY: 'b' }), 'a');
  assert.equal(resolveMicrovmApiKey({ BOOTSTRAP_API_KEY: ' boot ', E2B_API_KEY: 'e' }), 'boot');
  assert.equal(resolveMicrovmApiKey({ E2B_API_KEY: ' e2b ' }), 'e2b');
  assert.equal(
    resolveMicrovmApiKey({ RAW_AGENT_SANDBOX_MICROVM_API_KEY: ' raw ' }),
    'raw'
  );
  assert.equal(resolveMicrovmApiKey({}), undefined);
  assert.equal(resolveMicrovmApiKey({ MICROVM_API_KEY: '   ' }), undefined);
});

test('createMicrovmSandbox 201 success with defaults and optional body fields', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(201, {
      sandboxID: 'sbx_ok',
      envdAccessToken: 'tok',
      templateID: 'base'
    });
  };
  const result = await createMicrovmSandbox(
    {
      templateID: 'custom',
      timeout: 60,
      allow_internet_access: true,
      metadata: { a: '1' },
      envVars: { FOO: 'bar' }
    },
    { env: ENV_BASE, fetchImpl }
  );
  assert.equal(result.status, 201);
  assert.equal(result.sandbox.sandboxID, 'sbx_ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/sandboxes`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-Key'], 'test-api-key');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.templateID, 'custom');
  assert.equal(sent.timeout, 60);
  assert.equal(sent.allow_internet_access, true);
  assert.deepEqual(sent.metadata, { a: '1' });
  assert.deepEqual(sent.envVars, { FOO: 'bar' });
});

test('createMicrovmSandbox uses default template/timeout and omits unset optionals', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return jsonResponse(201, { sandboxID: 'sbx_def' });
  };
  await createMicrovmSandbox({}, { env: ENV_BASE, fetchImpl });
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.templateID, 'base');
  assert.equal(sent.timeout, 120);
  assert.equal('allow_internet_access' in sent, false);
  assert.equal('metadata' in sent, false);
  assert.equal('envVars' in sent, false);
});

test('createMicrovmSandbox throws on non-201 / missing sandboxID / missing URL / missing key', async () => {
  await assert.rejects(
    () =>
      createMicrovmSandbox(
        {},
        {
          env: ENV_BASE,
          fetchImpl: async () => jsonResponse(500, { error: 'boom' }, false)
        }
      ),
    /create failed HTTP 500/
  );
  await assert.rejects(
    () =>
      createMicrovmSandbox(
        {},
        {
          env: ENV_BASE,
          fetchImpl: async () => jsonResponse(201, { not: 'id' })
        }
      ),
    /create failed HTTP 201/
  );
  await assert.rejects(
    () => createMicrovmSandbox({}, { env: { MICROVM_API_KEY: 'k' }, fetchImpl: async () => jsonResponse(201, {}) }),
    /MICROVM_URL/
  );
  await assert.rejects(
    () =>
      createMicrovmSandbox(
        {},
        { env: { MICROVM_URL: BASE }, fetchImpl: async () => jsonResponse(201, { sandboxID: 'x' }) }
      ),
    /MICROVM_API_KEY/
  );
});

test('getMicrovmGuestHealth with provided guestURL + optional token', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { status: 'ok' });
  };
  const result = await getMicrovmGuestHealth('sbx_1', {
    env: ENV_BASE,
    fetchImpl,
    guestURL: 'http://172.16.0.2:49983/',
    envdAccessToken: 'guest-tok'
  });
  assert.equal(result.status, 200);
  assert.equal(result.guestURL, 'http://172.16.0.2:49983');
  assert.equal(result.body.status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://172.16.0.2:49983/health');
  assert.equal(calls[0].init.headers['X-Access-Token'], 'guest-tok');
});

test('getMicrovmGuestHealth looks up /internal/routes when guestURL missing', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/internal/routes/')) {
      return jsonResponse(200, {
        sandboxID: 'sbx_2',
        state: 'running',
        guestURL: 'http://172.16.0.9:1111/',
        envdAccessToken: 'from-route'
      });
    }
    return jsonResponse(200, { status: 'ok' });
  };
  const result = await getMicrovmGuestHealth('sbx_2', {
    env: { ...ENV_BASE, MICROVM_INTERNAL_TOKEN: 'internal-tok' },
    fetchImpl
  });
  assert.equal(result.guestURL, 'http://172.16.0.9:1111');
  assert.equal(calls[0].url, `${BASE}/internal/routes/sbx_2`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer internal-tok');
  assert.equal(calls[1].url, 'http://172.16.0.9:1111/health');
  assert.equal(calls[1].init.headers['X-Access-Token'], 'from-route');
});

test('getMicrovmGuestHealth error paths: missing token, bad routes, non-ok health', async () => {
  await assert.rejects(
    () => getMicrovmGuestHealth('sbx_x', { env: ENV_BASE, fetchImpl: async () => jsonResponse(200, {}) }),
    /guestURL not provided and MICROVM_INTERNAL_TOKEN/
  );

  await assert.rejects(
    () =>
      getMicrovmGuestHealth('sbx_x', {
        env: { ...ENV_BASE, INTERNAL_TOKEN: 'tok' },
        fetchImpl: async () => jsonResponse(404, { error: 'missing' }, false)
      }),
    /internal routes failed HTTP 404/
  );

  await assert.rejects(
    () =>
      getMicrovmGuestHealth('sbx_x', {
        env: ENV_BASE,
        fetchImpl: async () => jsonResponse(503, 'down', false),
        guestURL: 'http://guest.local'
      }),
    /guest health failed HTTP 503/
  );
});

test('deleteMicrovmSandbox 204 success and non-204 throw', async () => {
  const ok = await deleteMicrovmSandbox('sbx_del', {
    env: ENV_BASE,
    fetchImpl: async (url, init) => {
      assert.equal(url, `${BASE}/sandboxes/sbx_del`);
      assert.equal(init.method, 'DELETE');
      assert.equal(init.headers['X-API-Key'], 'test-api-key');
      return { status: 204, ok: true, text: async () => '' };
    }
  });
  assert.equal(ok.status, 204);

  await assert.rejects(
    () =>
      deleteMicrovmSandbox('sbx_del', {
        env: ENV_BASE,
        fetchImpl: async () => ({ status: 500, ok: false, text: async () => 'fail' })
      }),
    /delete failed HTTP 500/
  );
});

test('smokeMicrovmLifecycle happy path', async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(`${init?.method || 'GET'} ${url}`);
    if (String(url).endsWith('/sandboxes') && init?.method === 'POST') {
      return jsonResponse(201, { sandboxID: 'sbx_smoke', envdAccessToken: 't' });
    }
    if (String(url).includes('/internal/routes/')) {
      return jsonResponse(200, { guestURL: 'http://172.16.0.3:1', envdAccessToken: 't' });
    }
    if (String(url).endsWith('/health')) {
      return jsonResponse(200, { status: 'ok' });
    }
    if (init?.method === 'DELETE') {
      return { status: 204, ok: true, text: async () => '' };
    }
    return jsonResponse(500, { error: 'unexpected' }, false);
  };
  const result = await smokeMicrovmLifecycle({
    env: { ...ENV_BASE, MICROVM_INTERNAL_TOKEN: 'i' },
    fetchImpl,
    timeoutSeconds: 30
  });
  assert.equal(result.createStatus, 201);
  assert.equal(result.sandboxID, 'sbx_smoke');
  assert.equal(result.guestHealthStatus, 200);
  assert.equal(result.guestURL, 'http://172.16.0.3:1');
  assert.equal(result.deleteStatus, 204);
  assert.ok(urls.some((u) => u.startsWith('POST ')));
  assert.ok(urls.some((u) => u.startsWith('DELETE ')));
});

test('smokeMicrovmLifecycle cleans up on mid failure', async () => {
  /** @type {string[]} */
  const methods = [];
  const fetchImpl = async (url, init) => {
    methods.push(init?.method || 'GET');
    if (String(url).endsWith('/sandboxes') && init?.method === 'POST') {
      return jsonResponse(201, { sandboxID: 'sbx_fail' });
    }
    if (String(url).includes('/internal/routes/')) {
      return jsonResponse(500, { error: 'routes' }, false);
    }
    if (init?.method === 'DELETE') {
      return { status: 204, ok: true, text: async () => '' };
    }
    return jsonResponse(500, {}, false);
  };
  await assert.rejects(
    () =>
      smokeMicrovmLifecycle({
        env: { ...ENV_BASE, INTERNAL_TOKEN: 'i' },
        fetchImpl
      }),
    /internal routes failed/
  );
  assert.ok(methods.includes('DELETE'), 'expected best-effort cleanup delete');
});

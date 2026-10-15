import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { isPrivateOrReservedIp } from '../dist/goal/run-verify.js';
import {
  browserProfileDir,
  closeAllBrowserSessionsForTests,
  closeBrowserSession,
  formatBrowserError,
  ingestBrowserScreenshotPng,
  playwrightBrowserAction,
  probePlaywrightBackend,
  setPlaywrightLoaderForTests
} from '../dist/tools/browser-backend.js';

const ctx = {
  repoRoot: '/',
  stateDir: '/',
  session: {
    id: 's-browser',
    title: 't',
    mode: 'chat',
    status: 'idle',
    agentId: 'a',
    background: false,
    todo: [],
    metadata: {},
    createdAt: '',
    updatedAt: ''
  },
  agent: { id: 'a', name: 'a', role: 'x', instructions: '', capabilities: [] }
};

function sessionCtx(sessionId, stateDir) {
  return {
    ...ctx,
    repoRoot: stateDir,
    stateDir,
    session: { ...ctx.session, id: sessionId }
  };
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

after(async () => {
  await closeAllBrowserSessionsForTests();
  setPlaywrightLoaderForTests(undefined);
});

describe('browser backend error shape', () => {
  it('formatBrowserError is structured JSON', () => {
    const raw = formatBrowserError('browser_not_installed', 'missing', { kind: 'snapshot' });
    const body = JSON.parse(raw);
    assert.equal(body.error, 'browser_not_installed');
    assert.equal(body.message, 'missing');
    assert.ok(body.installHint.includes('playwright install'));
    assert.deepEqual(body.action, { kind: 'snapshot' });
  });

  it('returns structured failure when playwright is missing — never fake success', async () => {
    setPlaywrightLoaderForTests(async () => null);
    const r = await playwrightBrowserAction(ctx, { kind: 'snapshot' }, { env: {} });
    assert.equal(r.ok, false);
    const body = JSON.parse(r.content);
    assert.equal(body.error, 'browser_not_installed');
    assert.ok(body.installHint);
    assert.equal(body.action.kind, 'snapshot');
  });

  it('screenshot also fails soft when playwright is missing', async () => {
    const stateDir = tempDir('pw-missing-');
    setPlaywrightLoaderForTests(async () => null);
    try {
      const r = await playwrightBrowserAction(sessionCtx('s-missing-shot', stateDir), {
        kind: 'screenshot'
      }, { env: {} });
      assert.equal(r.ok, false);
      const body = JSON.parse(r.content);
      assert.equal(body.error, 'browser_not_installed');
      assert.equal(body.action.kind, 'screenshot');
      assert.equal(r.content.includes('base64'), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('maps launchPersistentContext failure', async () => {
    const stateDir = tempDir('pw-launch-');
    let persistent = 0;
    setPlaywrightLoaderForTests(async () => ({
      chromium: {
        launchPersistentContext: async () => {
          persistent += 1;
          throw new Error("Executable doesn't exist");
        }
      }
    }));
    try {
      const r = await playwrightBrowserAction(sessionCtx('s-launch-fail', stateDir), {
        kind: 'navigate',
        url: 'https://example.com'
      }, { env: {}, resolveHost: async () => ['93.184.216.34'] });
      assert.equal(persistent, 1);
      assert.equal(r.ok, false);
      const body = JSON.parse(r.content);
      assert.equal(body.error, 'browser_launch_failed');
      assert.equal(body.action.kind, 'navigate');
    } finally {
      await closeBrowserSession('s-launch-fail');
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('playwright probe', () => {
  it('reports a missing Playwright module without launching', async () => {
    setPlaywrightLoaderForTests(async () => null);
    const result = await probePlaywrightBackend();
    assert.equal(result.ok, false);
    assert.match(result.detail, /未安装/);
    assert.match(result.hint, /playwright install/);
  });

  it('launches a temporary context and removes the probe directory', async () => {
    let launched;
    setPlaywrightLoaderForTests(async () => ({
      chromium: {
        launchPersistentContext: async (dir, options) => {
          launched = { dir, options };
          assert.equal(existsSync(dir), true);
          return { close: async () => {} };
        }
      }
    }));
    const result = await probePlaywrightBackend();
    assert.equal(result.ok, true);
    assert.match(result.detail, /可用/);
    assert.equal(launched.options.headless, true);
    assert.equal(existsSync(launched.dir), false);
  });

  it('returns the launch error and still removes the probe directory', async () => {
    let dir;
    setPlaywrightLoaderForTests(async () => ({
      chromium: {
        launchPersistentContext: async (probeDir) => {
          dir = probeDir;
          throw 'browser missing';
        }
      }
    }));
    const result = await probePlaywrightBackend();
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'browser missing');
    assert.equal(existsSync(dir), false);
  });
});

describe('browser profile directory', () => {
  it('defaults to stateDir/browser-profiles/<sessionId> and honors the root override', () => {
    const stateDir = '/var/ppeng-state';
    const def = browserProfileDir(stateDir, 'sess_1', {});
    assert.equal(def, resolve(stateDir, 'browser-profiles', 'sess_1'));

    const root = '/tmp/ppeng-browser-root';
    const over = browserProfileDir(stateDir, 'sess_1', { RAW_AGENT_BROWSER_PROFILE_DIR: root });
    assert.equal(over, join(resolve(root), 'sess_1'));
  });

  it('does not let the session id escape the profile root', () => {
    const stateDir = '/var/ppeng-state';
    const escaped = browserProfileDir(stateDir, '..', {});
    const root = resolve(stateDir, 'browser-profiles');
    assert.equal(escaped, join(root, 'session'));
    const nested = browserProfileDir(stateDir, '../outside', {});
    assert.ok(nested.startsWith(root + sep));
    assert.equal(nested.includes(`${sep}..${sep}`), false);
  });
});

describe('persistent context and screenshot', () => {
  it('launches launchPersistentContext, reuses the same directory, and returns an asset id', async () => {
    const stateDir = tempDir('pw-persist-');
    const sessionId = 'sess_shot_1';
    const store = new SqliteStateStore(join(stateDir, 'runtime.sqlite'));
    const png = Buffer.concat([Buffer.from('UNIQUE_SCREENSHOT_BYTES_'), Buffer.alloc(480, 0xab)]);
    const b64 = png.toString('base64');
    assert.ok(b64.length > 200);
    const launches = [];
    let screenshotCalls = 0;
    const logs = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const prev = {};
    for (const method of methods) {
      prev[method] = console[method];
      console[method] = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
      };
    }

    const page = {
      goto: async () => {},
      url: () => 'https://example.com/home',
      title: async () => 'Home',
      content: async () => '<html><p>cookie=COOKIE_VALUE_SHOULD_NOT_BE_LOGGED</p></html>',
      locator: () => ({ click: async () => {}, fill: async () => {}, count: async () => 1 }),
      screenshot: async () => {
        screenshotCalls += 1;
        return png;
      }
    };
    setPlaywrightLoaderForTests(async () => ({
      chromium: {
        launchPersistentContext: async (dir, opts) => {
          launches.push({ dir, opts });
          return {
            pages: () => [page],
            newPage: async () => page,
            close: async () => {}
          };
        }
      }
    }));

    const runCtx = sessionCtx(sessionId, stateDir);
    const expectedDir = browserProfileDir(stateDir, sessionId, {});
    try {
      const snap = await playwrightBrowserAction(runCtx, { kind: 'snapshot' }, { env: {} });
      assert.equal(snap.ok, true);
      assert.match(snap.content, /«external source=browser /);
      assert.match(snap.content, /COOKIE_VALUE_SHOULD_NOT_BE_LOGGED/);

      const shot = await playwrightBrowserAction(runCtx, { kind: 'screenshot' }, {
        env: {},
        ingestScreenshot: (bytes, shotCtx) =>
          ingestBrowserScreenshotPng(store, stateDir, shotCtx.session.id, bytes)
      });
      assert.equal(shot.ok, true);
      const body = JSON.parse(shot.content);
      assert.equal(body.action, 'screenshot');
      assert.match(body.assetId, /^img_/);
      assert.equal(body.mimeType, 'image/png');
      assert.equal(shot.content.includes(b64), false);
      assert.equal(shot.content.includes(b64.slice(0, 80)), false);
      assert.equal(shot.content.includes('UNIQUE_SCREENSHOT_BYTES_'), false);
      assert.equal(JSON.stringify(shot).includes(b64), false);
      assert.equal(shot.images?.length, 1);
      assert.equal(shot.images[0].assetId, body.assetId);
      assert.equal(shot.images[0].type, 'image');
      assert.equal('data' in shot.images[0], false);

      const again = await playwrightBrowserAction(runCtx, { kind: 'screenshot' }, {
        env: {},
        ingestScreenshot: (bytes, shotCtx) =>
          ingestBrowserScreenshotPng(store, stateDir, shotCtx.session.id, bytes)
      });
      assert.equal(again.ok, true);
      assert.equal(launches.length, 1);
      assert.equal(launches[0].dir, expectedDir);
      assert.deepEqual(launches[0].opts, { headless: true });
      assert.equal(screenshotCalls, 2);

      await closeBrowserSession(sessionId);
      const reopened = await playwrightBrowserAction(runCtx, { kind: 'navigate', url: 'https://example.com' }, {
        env: {},
        resolveHost: async () => ['93.184.216.34']
      });
      assert.equal(reopened.ok, true);
      assert.equal(launches.length, 2);
      assert.equal(launches[1].dir, expectedDir);

      const unconfigured = await playwrightBrowserAction(sessionCtx('sess_no_ingest', stateDir), {
        kind: 'screenshot'
      }, { env: {} });
      assert.equal(unconfigured.ok, false);
      assert.equal(JSON.parse(unconfigured.content).error, 'browser_action_failed');
      assert.equal(unconfigured.content.includes(b64), false);

      for (const line of logs) {
        assert.equal(line.includes('COOKIE_VALUE_SHOULD_NOT_BE_LOGGED'), false);
        assert.equal(line.includes(b64.slice(0, 80)), false);
      }
    } finally {
      for (const method of methods) console[method] = prev[method];
      await closeAllBrowserSessionsForTests();
      try { store.db.close(); } catch { /* ignore */ }
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('refuses the host Chrome profile and does not launch', async () => {
    const stateDir = tempDir('pw-chrome-');
    const sessionId = 'ppeng_test_should_not_exist_51b9';
    let launches = 0;
    setPlaywrightLoaderForTests(async () => ({
      chromium: {
        launchPersistentContext: async () => {
          launches += 1;
          throw new Error('should not launch');
        }
      }
    }));
    const chrome = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    try {
      const r = await playwrightBrowserAction(sessionCtx(sessionId, stateDir), { kind: 'snapshot' }, {
        env: { RAW_AGENT_BROWSER_PROFILE_DIR: chrome }
      });
      assert.equal(launches, 0);
      assert.equal(r.ok, false);
      const body = JSON.parse(r.content);
      assert.equal(body.error, 'browser_launch_failed');
      assert.match(body.message, /Chrome/);
      assert.equal(r.content.includes(homedir()), false);
      assert.equal(existsSync(join(chrome, sessionId)), false);
    } finally {
      await closeBrowserSession(sessionId);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

function literalHost(url) {
  return new URL(url).hostname.replace(/^\[|\]$/g, '');
}

async function runNavigate(sessionId, url, options = {}) {
  const stateDir = tempDir('pw-nav-');
  const gotos = [];
  const launches = [];
  const aborts = [];
  const continued = [];
  const fulfilled = [];
  let routeHandler;
  const page = {
    goto: async (target) => {
      gotos.push(target);
      if (!options.follow) return;
      if (typeof routeHandler !== 'function') throw new Error('request was not intercepted');
      for (const request of options.follow) {
        let aborted = false;
        await routeHandler({
          request: () => ({
            url: () => request.url,
            method: () => request.method ?? 'GET',
            headers: () => request.headers ?? {},
            postData: () => request.postData ?? null,
            isNavigationRequest: () => request.document !== false,
            resourceType: () => (request.document === false ? 'script' : 'document')
          }),
          abort: async () => {
            aborted = true;
            aborts.push(request.url);
          },
          continue: async () => {
            continued.push(request.url);
          },
          ...(options.fulfill
            ? {
                fulfill: async (response) => {
                  fulfilled.push({
                    url: request.url,
                    status: response?.status,
                    headers: response?.headers,
                    body: response?.body
                  });
                }
              }
            : {})
        });
        if (aborted && request.document !== false) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      }
    },
    url: () => options.finalUrl ?? gotos.at(-1) ?? url,
    title: async () => 'Example',
    route: async (_pattern, handler) => {
      routeHandler = handler;
    },
    content: async () => '<html></html>',
    locator: () => ({ click: async () => {}, fill: async () => {}, count: async () => 0 }),
    screenshot: async () => Buffer.from('x')
  };
  setPlaywrightLoaderForTests(async () => ({
    chromium: {
      launchPersistentContext: async (dir) => {
        launches.push(dir);
        return { pages: () => [page], newPage: async () => page, close: async () => {} };
      }
    }
  }));
  try {
    const result = await playwrightBrowserAction(sessionCtx(sessionId, stateDir), { kind: 'navigate', url }, {
      env: options.env ?? {},
      resolveHost: options.resolveHost,
      request: options.request,
      connectTimeoutMs: options.connectTimeoutMs
    });
    return { result, gotos, launches, aborts, continued, fulfilled };
  } finally {
    await closeBrowserSession(sessionId);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function throwOnResolve() {
  return async () => {
    throw new Error('literal addresses must not be resolved');
  };
}

describe('browser navigation network policy', () => {
  it('browser navigation refuses private, loopback, link-local, and CGNAT addresses before opening a page [AC:browser-navigate-private-network#AC-1]', async () => {
    const blocked = [
      'http://127.0.0.1/',
      'http://127.0.0.1:9222/json',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://0x7f.0.0.1/',
      'http://127.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://10.1.2.3/secret',
      'http://192.168.0.10/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::ffff:192.168.1.1]/',
      'http://[::ffff:172.16.0.1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.1.1/',
      'http://[fe80::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://100.64.0.1/',
      'http://100.100.100.200/',
      'http://100.127.255.255/',
      'http://[::ffff:100.64.0.1]/',
      'http://[::ffff:100.100.100.200]/',
      'http://0.0.0.0/',
      'http://root:secret@127.0.0.1/latest'
    ];
    let n = 0;
    for (const url of blocked) {
      const host = literalHost(url);
      assert.equal(isPrivateOrReservedIp(host), true, host);
      const outcome = await runNavigate(`nav-block-${n}`, url, {
        env: n === 0 ? { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: '0' } : {},
        resolveHost: throwOnResolve()
      });
      n += 1;
      assert.equal(outcome.result.ok, false, url);
      assert.equal(outcome.launches.length, 0, url);
      assert.equal(outcome.gotos.length, 0, url);
      const body = JSON.parse(outcome.result.content);
      assert.equal(body.error, 'browser_action_failed');
      assert.match(body.message, /私网|回环|链路本地|运营商级 NAT/);
      assert.equal(outcome.result.content.includes('label=navigate'), false);
    }

    const redirected = await runNavigate('nav-redirect-private', 'https://example.com/start', {
      env: {},
      resolveHost: async () => ['93.184.216.34'],
      follow: [{ url: 'http://169.254.169.254/latest/meta-data', document: true }]
    });
    assert.equal(redirected.result.ok, false);
    assert.deepEqual(redirected.aborts, ['http://169.254.169.254/latest/meta-data']);
    assert.equal(redirected.continued.length, 0);
    assert.equal(redirected.result.content.includes('label=navigate'), false);
  });

  it('browser navigation refuses file URLs before opening a page [AC:browser-navigate-private-network#AC-2]', async () => {
    const blocked = [
      'file:///etc/passwd',
      'FILE:///tmp/secret',
      'file://localhost/etc/passwd',
      'file://127.0.0.1/etc/passwd'
    ];
    let n = 0;
    for (const url of blocked) {
      const outcome = await runNavigate(`nav-file-${n}`, url, { env: {}, resolveHost: throwOnResolve() });
      n += 1;
      assert.equal(outcome.result.ok, false, url);
      assert.equal(outcome.launches.length, 0, url);
      assert.equal(outcome.gotos.length, 0, url);
      const body = JSON.parse(outcome.result.content);
      assert.match(body.message, /file:\/\//);
    }
    const redirected = await runNavigate('nav-redirect-file', 'https://example.com/start', {
      env: { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: '1' },
      resolveHost: async () => ['93.184.216.34'],
      follow: [{ url: 'file:///etc/passwd', document: true }]
    });
    assert.equal(redirected.result.ok, false);
    assert.deepEqual(redirected.aborts, ['file:///etc/passwd']);
    assert.equal(redirected.continued.length, 0);
  });

  it('browser navigation refuses hostnames that resolve to private, loopback, link-local, or CGNAT addresses [AC:browser-navigate-private-network#AC-3]', async () => {
    const cases = [
      ['http://loop.example/', ['127.0.0.1']],
      ['http://lan.example/a', ['10.1.2.3']],
      ['http://meta.example/latest/meta-data', ['169.254.169.254']],
      ['http://cgnat.example/', ['100.100.100.200']],
      ['http://v6.example/', ['::1']],
      ['http://link.example/', ['fe80::1']],
      ['http://ula.example/', ['fd00::1']],
      ['http://mixed.example/latest', ['8.8.8.8', '192.168.0.1']]
    ];
    let n = 0;
    for (const [url, addresses] of cases) {
      for (const address of addresses) {
        if (address !== '8.8.8.8') assert.equal(isPrivateOrReservedIp(address), true, address);
      }
      const outcome = await runNavigate(`nav-dns-${n}`, url, {
        env: {},
        resolveHost: async () => addresses
      });
      n += 1;
      assert.equal(outcome.result.ok, false, url);
      assert.equal(outcome.launches.length, 0, url);
      assert.equal(outcome.gotos.length, 0, url);
    }
    const redirected = await runNavigate('nav-redirect-dns', 'https://example.com/start', {
      env: {},
      resolveHost: async (host) => (host === 'rebind.example' ? ['169.254.169.254'] : ['93.184.216.34']),
      follow: [{ url: 'http://rebind.example/latest', document: true }]
    });
    assert.equal(redirected.result.ok, false);
    assert.deepEqual(redirected.aborts, ['http://rebind.example/latest']);
    assert.equal(redirected.continued.length, 0);
  });

  it('browser navigation still opens public http(s) addresses [AC:browser-navigate-private-network#AC-4]', async () => {
    const allowed = [
      'http://8.8.8.8/',
      'http://1.1.1.1/',
      'http://100.63.255.255/',
      'http://100.128.0.1/',
      'http://172.15.255.255/',
      'http://172.32.0.1/',
      'http://[2001:4860:4860::8888]/',
      'http://[::ffff:8.8.8.8]/',
      '  http://8.8.8.8/trimmed  '
    ];
    let n = 0;
    for (const url of allowed) {
      const host = literalHost(url.trim());
      assert.equal(isPrivateOrReservedIp(host), false, host);
      const outcome = await runNavigate(`nav-public-${n}`, url, { env: {}, resolveHost: throwOnResolve() });
      n += 1;
      assert.equal(outcome.result.ok, true, url);
      assert.equal(outcome.launches.length, 1, url);
      assert.deepEqual(outcome.gotos, [url.trim()]);
      assert.match(outcome.result.content, /label=navigate/);
    }
    const named = await runNavigate('nav-public-name', 'https://example.com/home', {
      env: {},
      resolveHost: async () => ['93.184.216.34']
    });
    assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
    assert.equal(named.result.ok, true);
    assert.deepEqual(named.gotos, ['https://example.com/home']);
    const redirected = await runNavigate('nav-public-redirect', 'https://example.com/start', {
      env: {},
      resolveHost: async () => ['93.184.216.34'],
      finalUrl: 'http://1.1.1.1/next',
      follow: [{ url: 'http://1.1.1.1/next', document: true }]
    });
    assert.equal(redirected.result.ok, true);
    assert.deepEqual(redirected.continued, ['http://1.1.1.1/next']);
  });

  it('existing private-network switch allows private addresses and still refuses file URLs [AC:browser-navigate-private-network#AC-5]', async () => {
    const opened = await runNavigate('nav-switch-private', 'http://10.1.2.3/', {
      env: { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: 'TRUE' },
      resolveHost: throwOnResolve()
    });
    assert.equal(opened.result.ok, true);
    assert.deepEqual(opened.gotos, ['http://10.1.2.3/']);
    const named = await runNavigate('nav-switch-name', 'http://intranet.example/', {
      env: { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: 'yes' },
      resolveHost: async () => {
        throw new Error('should not resolve when private networks are allowed');
      }
    });
    assert.equal(named.result.ok, true);
    assert.deepEqual(named.gotos, ['http://intranet.example/']);
    const file = await runNavigate('nav-switch-file', 'file:///etc/passwd', {
      env: { RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE: '1' },
      resolveHost: throwOnResolve()
    });
    assert.equal(file.result.ok, false);
    assert.equal(file.launches.length, 0);
    assert.match(JSON.parse(file.result.content).message, /file:\/\//);
  });

  it('requires a url and does not fetch a private subresource from a public page', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,secret']) {
      const outcome = await runNavigate(`nav-scheme-${url.slice(0, 4)}`, url, { env: {}, resolveHost: throwOnResolve() });
      assert.equal(outcome.result.ok, false, url);
      assert.equal(outcome.launches.length, 0, url);
      assert.match(JSON.parse(outcome.result.content).message, /http\(s\)/);
    }
    const empty = await runNavigate('nav-empty', '   ', { env: {}, resolveHost: throwOnResolve() });
    assert.equal(empty.result.ok, false);
    assert.match(JSON.parse(empty.result.content).message, /url 必填/);
    assert.equal(empty.launches.length, 0);
    const failed = await runNavigate('nav-dns-fail', 'https://missing.example/', {
      env: {},
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      }
    });
    assert.equal(failed.result.ok, false);
    assert.equal(failed.launches.length, 0);
    assert.match(JSON.parse(failed.result.content).message, /域名解析失败/);
    const sub = await runNavigate('nav-subresource', 'https://example.com/', {
      env: {},
      resolveHost: async () => ['93.184.216.34'],
      finalUrl: 'https://example.com/',
      follow: [{ url: 'http://169.254.169.254/latest/meta-data', document: false }]
    });
    assert.equal(sub.result.ok, true);
    assert.deepEqual(sub.aborts, ['http://169.254.169.254/latest/meta-data']);
    assert.equal(sub.continued.length, 0);
    assert.match(sub.result.content, /label=navigate/);
  });

  it('pins navigation to the approved address and fails over when the first address cannot connect', async () => {
    const seen = [];
    const started = Date.now();
    const hang = (options) => new Promise((_resolve, reject) => {
      const fail = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (options.signal.aborted) fail();
      else options.signal.addEventListener('abort', fail, { once: true });
    });
    const pinned = await runNavigate('nav-pin-failover', 'https://example.com/page', {
      env: {},
      fulfill: true,
      connectTimeoutMs: 40,
      resolveHost: async () => ['203.0.113.10', '203.0.113.11'],
      follow: [{
        url: 'https://example.com/page',
        document: true,
        method: 'POST',
        headers: { Host: 'evil.test', 'X-Trace': '1', 'Content-Length': '7' },
        postData: 'payload'
      }],
      request: async (_url, address, options) => {
        seen.push({ address, method: options.method, body: options.body, trace: options.headers['X-Trace'], host: options.headers.Host });
        if (address === '203.0.113.10') return hang(options);
        return new Response('page', { status: 200, headers: { 'content-type': 'text/html' } });
      }
    });
    assert.equal(pinned.result.ok, true);
    assert.equal(pinned.continued.length, 0);
    assert.deepEqual(seen.map((item) => item.address), ['203.0.113.10', '203.0.113.11']);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, 'payload');
    assert.equal(seen[0].trace, '1');
    assert.equal(seen[0].host, undefined);
    assert.equal(pinned.fulfilled.length, 1);
    assert.equal(pinned.fulfilled[0].status, 200);
    assert.equal(pinned.fulfilled[0].headers['content-type'], 'text/html');
    assert.ok(Date.now() - started < 2500);

    const redirected = await runNavigate('nav-pin-redirect', 'https://example.com/start', {
      env: {},
      fulfill: true,
      connectTimeoutMs: 40,
      resolveHost: async () => ['203.0.113.10'],
      follow: [{ url: 'https://example.com/start', document: true }],
      request: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
    });
    assert.equal(redirected.fulfilled.length, 1);
    assert.equal(redirected.fulfilled[0].status, 302);
    assert.equal(redirected.fulfilled[0].headers.location, 'http://169.254.169.254/latest');
    assert.equal(redirected.continued.length, 0);

    const failed = await runNavigate('nav-pin-fail', 'https://example.com/page', {
      env: {},
      fulfill: true,
      connectTimeoutMs: 40,
      resolveHost: async () => ['203.0.113.10'],
      follow: [{ url: 'https://example.com/page', document: true }],
      request: async () => {
        throw new Error('secret-stack 203.0.113.10');
      }
    });
    assert.equal(failed.result.ok, false);
    assert.match(JSON.parse(failed.result.content).message, /导航连接失败/);
    assert.equal(failed.result.content.includes('secret-stack'), false);
    assert.deepEqual(failed.aborts, ['https://example.com/page']);
  });
});

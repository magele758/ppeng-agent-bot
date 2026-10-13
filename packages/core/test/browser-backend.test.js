import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  browserProfileDir,
  closeAllBrowserSessionsForTests,
  closeBrowserSession,
  formatBrowserError,
  ingestBrowserScreenshotPng,
  playwrightBrowserAction,
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
      }, { env: {} });
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
        env: {}
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

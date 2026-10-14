import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserToolsFeatureEnabled,
  createBrowserTools,
  defaultBrowserAction
} from '../dist/tools/browser-tools.js';

test('browserToolsFeatureEnabled defaults false', () => {
  assert.equal(browserToolsFeatureEnabled({}), false);
  assert.equal(browserToolsFeatureEnabled({ RAW_AGENT_BROWSER_TOOLS: '1' }), true);
});

test('createBrowserTools exposes navigate, snapshot, screenshot, click, and type', () => {
  const tools = createBrowserTools({
    runBrowserAction: (ctx, action) => defaultBrowserAction(ctx, action)
  });
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['browser_click', 'browser_navigate', 'browser_screenshot', 'browser_snapshot', 'browser_type']
  );
  const shot = tools.find((t) => t.name === 'browser_screenshot');
  assert.equal(shot.approvalMode, 'never');
  assert.equal(shot.sideEffectLevel, 'none');
  assert.deepEqual(shot.ptc, { kind: 'read' });
});

test('browser_screenshot delegates the screenshot action and does not inline bytes', async () => {
  let seen;
  const tools = createBrowserTools({
    runBrowserAction: async (_ctx, action) => {
      seen = action;
      return {
        ok: true,
        content: JSON.stringify({ ok: true, action: 'screenshot', assetId: 'img_x', mimeType: 'image/png' })
      };
    }
  });
  const shot = tools.find((t) => t.name === 'browser_screenshot');
  const result = await shot.execute({}, {});
  assert.deepEqual(seen, { kind: 'screenshot' });
  assert.match(result.content, /img_x/);
  assert.equal(result.content.includes('base64'), false);
});

test('defaultBrowserAction is the Playwright backend', () => {
  assert.equal(typeof defaultBrowserAction, 'function');
});

function navigateTool() {
  let calls = 0;
  const tools = createBrowserTools({
    runBrowserAction: async () => {
      calls += 1;
      return { ok: true, content: 'opened' };
    }
  });
  return { calls: () => calls, navigate: tools.find((tool) => tool.name === 'browser_navigate') };
}

async function withoutPrivateNetworkSwitch(run) {
  const prior = process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;
  delete process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;
    else process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE = prior;
  }
}

test('browser_navigate refuses private addresses and file URLs before calling the backend [AC:browser-navigate-private-network#AC-1] [AC:browser-navigate-private-network#AC-2]', async () => {
  await withoutPrivateNetworkSwitch(async () => {
    const blocked = [
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.0.10/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:100.64.0.1]/',
      'file:///etc/passwd',
      'FILE:///tmp/secret',
      'file://localhost/etc/passwd'
    ];
    for (const url of blocked) {
      const harness = navigateTool();
      const result = await harness.navigate.execute({}, { url });
      assert.equal(result.ok, false, url);
      assert.equal(harness.calls(), 0, url);
      assert.equal(result.content.includes('label=navigate'), false, url);
    }
  });
});

test('browser_navigate still opens a public address [AC:browser-navigate-private-network#AC-4]', async () => {
  await withoutPrivateNetworkSwitch(async () => {
    const harness = navigateTool();
    const result = await harness.navigate.execute({}, { url: 'http://8.8.8.8/dns' });
    assert.equal(result.ok, true);
    assert.equal(harness.calls(), 1);
  });
});

test('browser_navigate honors the existing private-network switch and still refuses file URLs [AC:browser-navigate-private-network#AC-5]', async () => {
  const prior = process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;
  process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE = '1';
  try {
    const allowed = navigateTool();
    const opened = await allowed.navigate.execute({}, { url: 'http://127.0.0.1/' });
    assert.equal(opened.ok, true);
    assert.equal(allowed.calls(), 1);
    const blocked = navigateTool();
    const file = await blocked.navigate.execute({}, { url: 'file:///etc/passwd' });
    assert.equal(file.ok, false);
    assert.equal(blocked.calls(), 0);
    assert.match(file.content, /file:\/\//);
  } finally {
    if (prior === undefined) delete process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE;
    else process.env.RAW_AGENT_WEB_FETCH_ALLOW_PRIVATE = prior;
  }
});

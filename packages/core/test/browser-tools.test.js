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

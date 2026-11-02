import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nextConfig from '../next.config.ts';

test('local development hides Next indicators and issue badge [AC:hide-dev-overlays#AC-1]', () => {
  assert.equal(nextConfig.devIndicators, false);
});
test('root layout does not inject element inspection toolbar [AC:hide-dev-overlays#AC-2]', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /react-grab|loadReactGrab/);
});

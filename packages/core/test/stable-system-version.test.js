import test from 'node:test';
import assert from 'node:assert/strict';
import { STABLE_SYSTEM_VERSION } from '../dist/model/prompt-builder.js';

test('STABLE_SYSTEM_VERSION is a non-empty fingerprint string', () => {
  assert.equal(typeof STABLE_SYSTEM_VERSION, 'string');
  assert.ok(STABLE_SYSTEM_VERSION.length > 0);
  // Contract: bump when buildStablePrefix wording changes (see model/AGENTS.md).
  assert.equal(STABLE_SYSTEM_VERSION, 'v14');
});

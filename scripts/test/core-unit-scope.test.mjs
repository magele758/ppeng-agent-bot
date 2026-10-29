import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { coreUnitFiles } from '../ci/core-unit.mjs';

test('core unit tests run beside the two-minute gate without coverage or browser [AC:ci-fast-and-bihourly-gates#AC-10]', () => {
  const files = coreUnitFiles();
  assert.ok(files.some((file) => file.startsWith('packages/core/test/')));
  assert.ok(files.some((file) => file.startsWith('apps/web-console/')));
  assert.equal(files.some((file) => file.includes('/formal/') || file.endsWith('formal-invariants.test.js')), false);
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const core = ci.jobs.core;
  assert.equal(core.name, 'Core unit tests');
  assert.equal(core.needs, undefined);
  assert.equal(ci.jobs.quick['timeout-minutes'], 2);
  assert.ok(core['timeout-minutes'] >= 8 && core['timeout-minutes'] <= 40);
  const steps = core.steps.map((step) => `${step.name ?? ''}\n${step.run ?? ''}`).join('\n');
  assert.match(steps, /core-unit\.mjs/);
  assert.doesNotMatch(steps, /playwright|NODE_V8_COVERAGE|test:e2e|soak|mutation/i);
});

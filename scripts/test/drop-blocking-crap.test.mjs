import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseFailures } from '../ci/release-results.mjs';

function workflow() {
  return readFileSync(new URL('../../.github/workflows/release-gate.yml', import.meta.url), 'utf8');
}

test('complexity failure does not fail an otherwise green release [AC:drop-blocking-crap#AC-1]', () => {
  const green = Object.fromEntries(['tests', 'unit', 'formal', 'sdk', 'browser', 'acceptance', 'mutation', 'secrets-gate', 'soak-performance'].map((name) => [name, { result: 'success' }]));
  assert.deepEqual(releaseFailures(green), []);
  assert.deepEqual(releaseFailures({ ...green, crap: { result: 'failure' } }), []);
  assert.deepEqual(releaseFailures({ ...green, crap: { result: 'skipped' } }), []);
});

test('release workflow has no blocking complexity job [AC:drop-blocking-crap#AC-2]', () => {
  const source = workflow();
  assert.doesNotMatch(source, /^ {2}crap:/m);
  assert.doesNotMatch(source, /crap-gate\.mjs/);
  assert.doesNotMatch(source, /- crap\n/);
});

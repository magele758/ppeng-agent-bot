import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflows = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const read = (name) => readFileSync(join(workflows, name), 'utf8');

test('publish and push have no observe-mode or bypass variable', () => {
  for (const file of ['publish-npm.yml', 'docker-nightly.yml', 'release-gate.yml']) {
    assert.doesNotMatch(read(file), /RELEASE_GATE_ENFORCE/, `${file} must not read a gate bypass variable`);
  }
});

test('release-gate.yml keeps the required-check job name and the flaky-aware unit step', () => {
  const src = read('release-gate.yml');
  assert.match(src, /\n  gate:\n    name: Main release gate\n/);
  assert.match(src, /node scripts\/ci\/validation-lane\.mjs unit --out/);
  const runner=readFileSync(new URL('../ci/validation-lane.mjs',import.meta.url),'utf8');
  assert.match(runner, /retry-failed-tests\.mjs','--script','test:unit','--lane',lane/);
  assert.doesNotMatch(src, /run: npm run test:unit/, 'unit tests must go through the retry wrapper');
});

test('ci.yml exposes the gate as "Release gate / Main release gate"', () => {
  assert.match(read('ci.yml'), /\n  release-gate:\n    name: Release gate\n    uses: \.\/\.github\/workflows\/release-gate\.yml/);
});

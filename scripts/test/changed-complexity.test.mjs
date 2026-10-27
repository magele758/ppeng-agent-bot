import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changedLineSet, overComplexTouched, COMPLEXITY_LIMIT } from '../ci/changed-complexity.mjs';

const hot = `function hot(x) {\n${Array.from({ length: 31 }, () => '  if (x) return 1;\n').join('')}}\nfunction cold() { return 1; }\n`;

test('a touched function over 30 fails and an untouched one does not [AC:ci-fast-and-bihourly-gates#AC-9]', () => {
  assert.equal(COMPLEXITY_LIMIT, 30);
  const touched = overComplexTouched('sample.ts', hot, new Set([2]));
  assert.deepEqual(touched.map((fn) => fn.name), ['hot']);
  assert.ok(touched[0].complexity > 30);
  assert.deepEqual(overComplexTouched('sample.ts', hot, new Set([hot.split('\n').length])), []);
  assert.equal(changedLineSet('@@ -1 +2,1 @@\n+  if (x) return 1;\n').has(2), true);
  assert.match(readFileSync('scripts/ci/quick-gate.mjs', 'utf8'), /changed-complexity\.mjs/);
});

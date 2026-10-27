import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedLineSet, comparisonBase, overComplexChanges, overComplexTouched, COMPLEXITY_LIMIT } from '../ci/changed-complexity.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

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

test('a merge commit ignores complex functions that arrived from the base branch [AC:ci-fast-and-bihourly-gates#AC-9]', () => {
  const root = mkdtempSync(join(tmpdir(), 'complexity-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'ci@example.com']);
  git(root, ['config', 'user.name', 'ci']);
  const hot = `function hot(x) {\n${Array.from({ length: 31 }, () => '  if (x) return 1;\n').join('')}}\n`;
  writeFileSync(join(root, 'hot.ts'), hot);
  git(root, ['add', 'hot.ts']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', 'pr']);
  writeFileSync(join(root, 'note.txt'), 'pr\n');
  git(root, ['add', 'note.txt']);
  git(root, ['commit', '-m', 'pr']);
  git(root, ['checkout', 'main']);
  writeFileSync(join(root, 'hot.ts'), hot + 'const extra = 1;\n');
  git(root, ['add', 'hot.ts']);
  git(root, ['commit', '-m', 'main moves the complex function']);
  git(root, ['checkout', 'pr']);
  git(root, ['merge', 'main', '-m', 'merge']);
  assert.equal(comparisonBase(root), spawnSync('git', ['rev-parse', 'HEAD^1'], { cwd: root, encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(overComplexChanges(root), []);
});

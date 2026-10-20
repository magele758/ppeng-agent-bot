import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * yarn records each workspace as `name@file:<absolute checkout>`. A local install
 * therefore rewrites yarn.lock to the machine that ran it (and can bump stale
 * descriptor versions). CI installs with `npm ci` from package-lock.json, so that
 * rewrite is never a dependency change. The only absolute locators that may stay
 * are the historical `/workspace/...` descriptors already on main.
 *
 * npm 7+ also syncs an existing yarn.lock during `npm ci`, so on a CI runner the
 * working-tree copy already carries `/home/runner/...` locators before any test
 * runs. The guard is about what gets committed, so it reads the committed blob
 * (HEAD) and only falls back to the working tree outside a git checkout.
 */
const LOCKFILES = ['pnpm-lock.yaml'];
const HOME_DIR = /(?:^|[\s"'=])(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/m;

function absoluteFileLocators(text) {
  return [...text.matchAll(/file:(\/[^\s"',]+)/g)].map((match) => match[1]);
}

function committedText(file) {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return readFileSync(file, 'utf8');
  }
}

export function lockfileProblems(file, text) {
  const problems = [];
  if (HOME_DIR.test(text)) problems.push(`${file} contains a home-directory path`);
  const foreign = absoluteFileLocators(text).filter((locator) => !locator.startsWith('/workspace/'));
  if (foreign.length) problems.push(`${file} has absolute file: locators outside /workspace: ${foreign.join(', ')}`);
  return problems;
}

test('lockfiles do not record a machine-local checkout path', () => {
  for (const file of LOCKFILES) {
    assert.deepEqual(lockfileProblems(file, committedText(file)), []);
  }
});

test('the guard still rejects a runner-rewritten yarn.lock', () => {
  const rewritten = '"@ppeng/core@file:/home/runner/work/ppeng-agent-core/ppeng-agent-core/packages/core":\n  version "0.1.0"\n';
  const problems = lockfileProblems('yarn.lock', rewritten);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /absolute file: locators outside \/workspace: \/home\/runner\//);
  assert.deepEqual(lockfileProblems('yarn.lock', '"x@file:/workspace/packages/x":\n'), []);
});

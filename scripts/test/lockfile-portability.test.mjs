import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * yarn records each workspace as `name@file:<absolute checkout>`. A local install
 * therefore rewrites yarn.lock to the machine that ran it (and can bump stale
 * descriptor versions). CI installs with `npm ci` from package-lock.json, so that
 * rewrite is never a dependency change. The only absolute locators that may stay
 * are the historical `/workspace/...` descriptors already on main.
 */
const LOCKFILES = ['yarn.lock', 'package-lock.json'];
const HOME_DIR = /(?:^|[\s"'=])(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)/m;

function absoluteFileLocators(text) {
  return [...text.matchAll(/file:(\/[^\s"',]+)/g)].map((match) => match[1]);
}

test('lockfiles do not record a machine-local checkout path', () => {
  for (const file of LOCKFILES) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, HOME_DIR, `${file} contains a home-directory path`);
    const foreign = absoluteFileLocators(text).filter((locator) => !locator.startsWith('/workspace/'));
    assert.deepEqual(foreign, [], `${file} has absolute file: locators outside /workspace`);
  }
});

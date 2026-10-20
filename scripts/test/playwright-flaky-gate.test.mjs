import {createRequire} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/package.json').replace(/package\.json$/, 'cli.js');

/**
 * Run one browser-less spec under the repo's real playwright.config.ts
 * (retries / failOnFlakyTests come from it; only testDir/projects/use are
 * swapped so no browser or server is needed).
 */
function runSpec(spec, env) {
  const dir = mkdtempSync(join(repoRoot, '.tmp-pw-flaky-'));
  try {
    writeFileSync(
      join(dir, 'pw.config.ts'),
      `import base from ${JSON.stringify(join(repoRoot, 'playwright.config.ts'))};
export default { ...base, testDir: ${JSON.stringify(dir)}, projects: [{ name: 'node' }], use: {}, outputDir: ${JSON.stringify(join(dir, 'out'))} };
`
    );
    writeFileSync(join(dir, 'x.spec.ts'), `import { test, expect } from '@playwright/test';\n${spec}\n`);
    const { CI: _ci, ...rest } = process.env;
    return spawnSync(process.execPath, [playwrightCli, 'test', '--config', join(dir, 'pw.config.ts'), '--reporter=line'], {
      cwd: repoRoot,
      env: { ...rest, ...env },
      encoding: 'utf8',
      timeout: 60_000
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passesOnlyOnRetry = `test('flaky', ({}, info) => { expect(info.retry).toBe(1); });`;

test('CI: a test that only passes on retry fails the e2e run', { timeout: 90_000 }, () => {
  const r = runSpec(passesOnlyOnRetry, { CI: '1' });
  assert.notEqual(r.status, 0, `flaky pass must fail CI\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /1 flaky/);
});

test('CI: a stable test still passes', { timeout: 90_000 }, () => {
  const r = runSpec(`test('stable', () => { expect(1).toBe(1); });`, { CI: '1' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test('local: no retries, so the same test simply fails', { timeout: 90_000 }, () => {
  const r = runSpec(passesOnlyOnRetry, {});
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /1 failed/);
});

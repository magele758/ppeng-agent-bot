import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildSelfHealWorkspace,
  runSelfHealNpmTest,
  selfHealScriptNeedsPrebuild
} from '../dist/self-heal/self-heal-executors.js';
import { normalizeSelfHealPolicy } from '../dist/self-heal/self-heal-policy.js';

/**
 * A stand-in for a fresh self-heal worktree: `dist/` is gitignored, so it only exists
 * after scripts/build-workspace.mjs ran. The "test" fails like ERR_MODULE_NOT_FOUND without it.
 */
function makeWorktree({ buildExit = 0, withBuildScript = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'self-heal-prebuild-'));
  mkdirSync(path.join(dir, 'scripts'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fake-worktree',
      private: true,
      scripts: {
        'test:unit': 'node check-dist.mjs',
        build: 'node -e "require(\'fs\').appendFileSync(\'build-runs.txt\', \'x\')"'
      }
    })
  );
  writeFileSync(
    path.join(dir, 'check-dist.mjs'),
    "import { existsSync } from 'node:fs';\n" +
      "if (!existsSync('packages/x/dist/state-machine.js')) {\n" +
      "  console.error(\"Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'packages/x/dist/state-machine.js'\");\n" +
      '  process.exit(1);\n}\n'
  );
  if (withBuildScript) {
    writeFileSync(
      path.join(dir, 'scripts', 'build-workspace.mjs'),
      "import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\n" +
        "mkdirSync('packages/x/dist', { recursive: true });\n" +
        "writeFileSync('packages/x/dist/state-machine.js', 'export {};\\n');\n" +
        "appendFileSync('build-runs.txt', 'x');\n" +
        (buildExit ? `console.error('TS2349: type error');\nprocess.exit(${buildExit});\n` : '')
    );
  }
  return dir;
}

describe('self-heal test runs build workspace packages first', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('only scripts that do not build themselves need the prebuild', () => {
    assert.equal(selfHealScriptNeedsPrebuild('test:unit'), true);
    assert.equal(selfHealScriptNeedsPrebuild('test:regression'), true);
    assert.equal(selfHealScriptNeedsPrebuild('build'), false);
    assert.equal(selfHealScriptNeedsPrebuild('ci'), false);
  });

  it('unit preset passes in a worktree without dist because dist is built first', async () => {
    dir = makeWorktree();
    assert.equal(existsSync(path.join(dir, 'packages/x/dist')), false);
    const res = await runSelfHealNpmTest(dir, normalizeSelfHealPolicy({ testPreset: 'unit' }));
    assert.equal(res.ok, true, res.output);
    assert.equal(readFileSync(path.join(dir, 'build-runs.txt'), 'utf8'), 'x');
  });

  it('the build preset is not built twice', async () => {
    dir = makeWorktree();
    const res = await runSelfHealNpmTest(dir, normalizeSelfHealPolicy({ testPreset: 'build' }));
    assert.equal(res.ok, true, res.output);
    assert.equal(existsSync(path.join(dir, 'build-runs.txt')), true);
    assert.equal(readFileSync(path.join(dir, 'build-runs.txt'), 'utf8'), 'x');
    assert.equal(existsSync(path.join(dir, 'packages/x/dist')), false);
  });

  it('a worktree without a build script still runs the tests (no crash)', async () => {
    dir = makeWorktree({ withBuildScript: false });
    const res = await runSelfHealNpmTest(dir, normalizeSelfHealPolicy({ testPreset: 'unit' }));
    assert.equal(res.ok, false);
    assert.match(res.output, /ERR_MODULE_NOT_FOUND/);
    assert.equal((await buildSelfHealWorkspace(dir)).skipped, true);
  });

  it('a build that exits non-zero still runs tests, and a failing test reports the compile errors', async () => {
    dir = makeWorktree({ buildExit: 2 });
    const passing = await runSelfHealNpmTest(dir, normalizeSelfHealPolicy({ testPreset: 'unit' }));
    assert.equal(passing.ok, true, passing.output);

    rmSync(path.join(dir, 'packages'), { recursive: true });
    writeFileSync(path.join(dir, 'check-dist.mjs'), 'process.exit(1);\n');
    const failing = await runSelfHealNpmTest(dir, normalizeSelfHealPolicy({ testPreset: 'unit' }));
    assert.equal(failing.ok, false);
    assert.match(failing.output, /workspace build failed/);
    assert.match(failing.output, /TS2349/);
  });
});

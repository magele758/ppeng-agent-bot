// Product unit tests for a PR. No coverage, browser, soak, mutation, or formal
// process lane. Those stay on the full validation that runs after main updates.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';
import { ROOT, discoverTests } from './test-partition.mjs';

const PREFIXES = ['packages/core/test/', 'apps/web-console/lib/', 'apps/web-console/components/'];

export function coreUnitFiles(plan = discoverTests()) {
  return plan.unit.filter((file) => PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function run(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, args, { cwd, env: sanitizeScriptEnv(), stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? `exit ${result.status}: ${args[0]}`);
  }
}

function main() {
  const files = coreUnitFiles();
  if (!files.length) throw new Error('Core unit scope is empty');
  console.log(`[core-unit] ${files.length} node tests`);
  run(['--experimental-strip-types', '--test', '--test-concurrency=1', ...files]);
  const require = createRequire(join(ROOT, 'packages/agent-loop/package.json'));
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  console.log('[core-unit] agent-loop vitest');
  run([cli, 'run'], join(ROOT, 'packages/agent-loop'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

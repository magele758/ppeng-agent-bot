#!/usr/bin/env node
/**
 * Formal regression: invariants + MockLLM + bounded pairing/lifecycle model and implementation verification.
 * Does NOT run TLC. A bounded design-model pass is not a proof of the whole implementation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMAL_REGRESSION_TESTS } from '../ci/test-partition.mjs';
import { checkTla } from './tla-sanity.mjs';
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const REQUIRED = [
  'packages/core/src/formal/index.ts',
  'packages/core/src/formal/invariants.ts',
  'packages/core/src/formal/pbt.ts',
  'packages/core/src/formal/session-lifecycle.ts',
  'packages/core/src/model/mock-llm-provider.ts',
  'packages/core/test/formal-invariants.test.js',
  'packages/core/test/mock-llm-e2e.test.js',
  'specs/formal/tla/GoalStateMachine.tla',
  'specs/formal/tla/SessionLifecycle.tla',
  'specs/formal/tla/ToolCallPairing.tla',
  'doc/formal/README.md'
];

const TESTS = FORMAL_REGRESSION_TESTS;
const verificationOnly=process.argv.slice(2).includes('--verification-only');
if(process.argv.slice(2).some(a=>a!=='--verification-only'))throw new Error('Unknown formal argument');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

console.log('formal regression (bounded pairing/lifecycle models + implementation probes / invariants / PBT / MockLLM; not TLC)\n');

const pairing = spawnSync(process.execPath, ['scripts/formal/run-pairing-verification.mjs'], {
  cwd: ROOT, stdio: 'inherit', env: sanitizeScriptEnv(), timeout: 70000,
});
if (pairing.error || pairing.status !== 0) fail(`pairing verification did not pass (${pairing.error?.message ?? pairing.status})`);

const lifecycle = spawnSync(process.execPath, ['scripts/formal/run-lifecycle-verification.mjs'], {
  cwd: ROOT, stdio: 'inherit', env: sanitizeScriptEnv(), timeout: 190000,
});
if (lifecycle.error || lifecycle.status !== 0) fail(`lifecycle verification did not pass (${lifecycle.error?.message ?? lifecycle.status})`);

const restart = spawnSync(process.execPath, ['scripts/formal/run-restart-verification.mjs'], {
  cwd: ROOT, stdio: 'inherit', env: sanitizeScriptEnv(), timeout: 310000,
});
if (restart.error || restart.status !== 0) fail(`restart recovery verification did not pass (${restart.error?.message ?? restart.status})`);

const concurrency = spawnSync(process.execPath, ['scripts/formal/run-concurrency-verification.mjs'], {
  cwd: ROOT, stdio: 'inherit', env: sanitizeScriptEnv(), timeout: 550000,
});
if (concurrency.error || concurrency.status !== 0) fail(`multiprocess concurrency verification did not pass (${concurrency.error?.message ?? concurrency.status})`);

for (const rel of REQUIRED) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) fail(`missing required file: ${rel}`);
  console.log(`  ✓ present ${rel}`);
}

const tlaDir = join(ROOT, 'specs/formal/tla');
const tla = readdirSync(tlaDir).filter((n) => n.endsWith('.tla'));
if (tla.length < 3) fail(`expected >=3 TLA drafts, got ${tla.length}`);

for (const file of tla) {
  const cfg = join(tlaDir, file.replace(/\.tla$/, '.cfg'));
  if (!existsSync(cfg)) fail('missing cfg: ' + cfg);
  const errors = checkTla(file.slice(0, -4), readFileSync(join(tlaDir, file), 'utf8'), readFileSync(cfg, 'utf8'));
  if (errors.length) fail(errors.join('; '));
  console.log('  ✓ structural sanity ' + file);
}
const start = Date.now();
const res = verificationOnly ? {status:0} : spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...TESTS],
  { cwd: ROOT, stdio: 'inherit', env: sanitizeScriptEnv() }
);
if (res.status !== 0) fail(`unit suite failed (exit ${res.status})`);

console.log(
  `\nformal regression checks passed (${Date.now() - start}ms; bounded pairing/lifecycle models + implementation probes + unit/PBT/MockLLM; not a whole-system proof)`
);

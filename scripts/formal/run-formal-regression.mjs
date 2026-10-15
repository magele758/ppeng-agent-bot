#!/usr/bin/env node
/**
 * Formal regression: executable invariants + MockLLM E2E + TLA draft presence.
 * Does NOT run TLC. Passing is not a formal proof.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTla } from './tla-sanity.mjs';

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

const TESTS = [
  'packages/core/test/formal-invariants.test.js',
  'packages/core/test/mock-llm-e2e.test.js',
  'packages/core/test/goal-state-machine.test.js',
  'packages/core/test/session-surface.test.js'
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

console.log('formal regression (invariants / PBT / MockLLM; not TLC)\n');

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
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...TESTS],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env } }
);
if (res.status !== 0) fail(`unit suite failed (exit ${res.status})`);

console.log(
  `\nformal regression checks passed (${Date.now() - start}ms; unit/PBT/MockLLM only, not formally verified)`
);

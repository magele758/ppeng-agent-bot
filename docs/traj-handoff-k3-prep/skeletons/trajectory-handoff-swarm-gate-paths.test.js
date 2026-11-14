/**
 * Knife-3 PREP skeleton: #516 real Swarm call / recovery paths.
 *
 * Not in packages/core/test/. Do not loosen gate.ts or delivery mapping.
 * Delivery-mapping DM-1…DM-9 remain necessary but not sufficient.
 *
 * After the approved Swarm entry exists, these cases must run on a real
 * teammate call + resume path, not only a state-table lookup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = resolve(ROOT, 'packages/core/src/quality/gate.ts');
const EXECUTOR = resolve(ROOT, 'packages/core/src/swarm/executor.ts');
const DM_TEST = resolve(ROOT, 'packages/core/test/trajectory-handoff-delivery-mapping.test.js');
const DM_YAML = resolve(ROOT, 'acceptance/delivery-mapping.yaml');
const ENGINE = resolve(ROOT, 'packages/core/src/orchestrator/engine.ts');

const NON_SUCCESS_STATES = [
  'answered',
  'capped',
  'failed',
  'cancelled',
  'timed_out',
  'awaiting_coordinator',
  'done',
];

test('characterization: gate.ts still exists and executor still uses qualityPassed', () => {
  assert.ok(existsSync(GATE), 'do not delete or bypass gate.ts');
  const exec = readFileSync(EXECUTOR, 'utf8');
  assert.match(exec, /import \{ failedQuality, qualityPassed/);
  assert.match(exec, /qualityPassed\(report\)/);
  assert.match(exec, /failedQuality\('Independent quality evaluator missing'\)/);
});

test('characterization: delivery-mapping acceptance assets still present', () => {
  assert.ok(existsSync(DM_TEST));
  assert.ok(existsSync(DM_YAML));
  const yaml = readFileSync(DM_YAML, 'utf8');
  for (const state of NON_SUCCESS_STATES) {
    assert.ok(
      yaml.includes(state) || readFileSync(DM_TEST, 'utf8').includes(state),
      `delivery mapping must keep covering ${state}`,
    );
  }
});

test('D1 missing evidence on a real Swarm completion must not pass the gate', { skip: true }, () => {
  assert.fail('needs approved Swarm entry + recovery path');
});

test('D1 unavailable evidence on a real Swarm completion must not pass the gate', { skip: true }, () => {
  assert.fail('needs approved Swarm entry + recovery path');
});

test('D1 stale planVersion evidence must not be reused', { skip: true }, () => {
  assert.fail('needs approved Swarm entry + recovery path');
});

test('D2 resume then complete still runs the quality gate', { skip: true }, () => {
  assert.fail('needs approved Swarm entry + recovery path');
});

test('D3 kernel non-success and done never map to delivery success on the Swarm path', { skip: true }, () => {
  for (const state of NON_SUCCESS_STATES) {
    assert.ok(state);
  }
  assert.fail('re-verify on the real Swarm path, not only DM table');
});

test('D4 missing reviewer already fails the in-progress task; do not treat swarm completed as sufficient delivery', { skip: true }, () => {
  assert.fail('independent Swarm path must keep qualityPassed; do not change gate.ts');
});

test('characterization: tryCompleteImplementStep does not call qualityPassed and maps swarm completed to step completed', () => {
  const src = readFileSync(ENGINE, 'utf8');
  assert.match(src, /import \{ qualityPassed/, 'review/test path still imports qualityPassed; do not treat the whole file as lacking the gate');
  assert.match(src, /qualityPassed\(result\)/);
  const terminal = src.match(/const TERMINAL_SWARM[^\n]+/);
  assert.ok(terminal, 'TERMINAL_SWARM still lists terminal swarm statuses');
  assert.match(terminal[0], /'completed'/);
  assert.match(terminal[0], /'failed'/);
  assert.match(terminal[0], /'cancelled'/);

  const start = src.indexOf('private tryCompleteImplementStep');
  assert.ok(start >= 0, 'tryCompleteImplementStep still present');
  const next = src.indexOf('\n  private ', start + 'private tryCompleteImplementStep'.length);
  assert.ok(next > start, 'slice must stop at the next method');
  const slice = src.slice(start, next);
  assert.equal(/qualityPassed/.test(slice), false, 'implement completion must not call qualityPassed');
  assert.match(slice, /TERMINAL_SWARM\.includes\(swarm\.status\)/);
  const failedLine = slice.match(/const failed = ([^\n]+)/);
  assert.ok(failedLine, 'failed predicate still distinguishes failed and cancelled');
  assert.match(failedLine[1], /swarm\.status === 'failed'/);
  assert.match(failedLine[1], /swarm\.status === 'cancelled'/);
  assert.equal(failedLine[1].includes("'completed'"), false, 'swarm completed is not a failed step');
  assert.match(slice, /status: failed \? 'failed' : 'completed'/);
});

test('characterization: these skeleton files are not under packages/core/test', () => {
  const here = fileURLToPath(import.meta.url);
  const coreTestDir = resolve(ROOT, 'packages/core/test');
  assert.equal(here.startsWith(coreTestDir + sep), false, here);
  assert.equal(here.includes(`${sep}packages${sep}core${sep}test${sep}`), false, here);
  const relHere = relative(ROOT, here);
  assert.equal(relHere.startsWith(`packages${sep}core${sep}test`), false, relHere);

  const dir = dirname(here);
  for (const name of [
    'trajectory-handoff-swarm-entry.test.js',
    'trajectory-handoff-swarm-refill.test.js',
    'trajectory-handoff-swarm-gate-paths.test.js',
  ]) {
    const file = resolve(dir, name);
    const rel = relative(ROOT, file);
    assert.equal(file.startsWith(coreTestDir + sep), false, file);
    assert.equal(rel.includes(`packages${sep}core${sep}test`), false, rel);
    assert.equal(rel.split(sep)[0], 'docs', rel);
    assert.ok(existsSync(file), file);
  }
});

test('D6 evidence must be bound to the verified version and task scope', { skip: true }, () => {
  assert.fail('needs approved Swarm entry; evidence from an old plan version or old task scope must not pass the gate');
});

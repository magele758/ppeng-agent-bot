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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = resolve(ROOT, 'packages/core/src/quality/gate.ts');
const EXECUTOR = resolve(ROOT, 'packages/core/src/swarm/executor.ts');
const DM_TEST = resolve(ROOT, 'packages/core/test/trajectory-handoff-delivery-mapping.test.js');
const DM_YAML = resolve(ROOT, 'acceptance/delivery-mapping.yaml');

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

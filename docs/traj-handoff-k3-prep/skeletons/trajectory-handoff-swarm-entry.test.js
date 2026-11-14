/**
 * Knife-3 PREP skeleton: Swarm entry isolation.
 *
 * DO NOT copy into packages/core/test/ until the conditions in
 * ../fixture-notes.md are met. This folder is outside test:unit globs.
 *
 * Characterization below inspects source on tip c67112bc and asserts the
 * production Swarm entry is still CLOSED. It does not implement an entry,
 * does not add Pattern B closed-entry primitives, and must not start
 * importing a default of independent_swarm.
 *
 * After knife-3 implementation (entry opened for trusted independent_swarm
 * only), keep the fail-closed cases and flip ONLY the trusted-open case
 * from skipped to live. Flywheel must stay closed until knife 4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRootFromHere() {
  // docs/traj-handoff-k3-prep/skeletons/this-file → repo root is ../../..
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

const ROOT = repoRootFromHere();
const EXECUTOR_SRC = resolve(ROOT, 'packages/core/src/swarm/executor.ts');
const ENGINE_SRC = resolve(ROOT, 'packages/core/src/orchestrator/engine.ts');

function read(path) {
  assert.ok(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

test('characterization: SwarmExecutor source does not import trajectory-handoff', () => {
  const src = read(EXECUTOR_SRC);
  assert.equal(
    /trajectory-handoff/.test(src),
    false,
    'executor must not import trajectory-handoff while the production entry stays closed',
  );
});

test('characterization: dispatchTask metadata has no trusted handoff source', () => {
  const src = read(EXECUTOR_SRC);
  const dispatch = src.slice(src.indexOf('private async dispatchTask'));
  const meta = dispatch.match(/metadata:\s*\{([\s\S]*?)\}/);
  assert.ok(meta, 'dispatchTask should still build a metadata object (tip shape)');
  const body = meta[1];
  assert.match(body, /swarmRunId/);
  assert.match(body, /swarmTaskId/);
  assert.match(body, /autoRun/);
  for (const forbidden of [
    'independent_swarm',
    'handoffSource',
    'source:',
    'refillId',
    'enablement',
    'grantedQuota',
  ]) {
    assert.equal(
      body.includes(forbidden),
      false,
      `dispatchTask metadata must not carry ${forbidden} on a closed entry`,
    );
  }
});

test('characterization: non-pipeline strategies still fail closed', () => {
  const src = read(EXECUTOR_SRC);
  assert.match(src, /run\.strategy !== 'pipeline'/);
  assert.match(src, /only pipeline is implemented/);
  assert.match(src, /updateRunStatus\(run\.id, 'failed'\)/);
});

test('characterization: flywheel implement hook does not mention handoff enablement', () => {
  const src = read(ENGINE_SRC);
  assert.match(src, /startSwarmForRun/);
  assert.equal(
    /independent_swarm|trajectory-handoff|handoffSource/.test(src),
    false,
    'engine must not enable handoff by entering the shared Swarm executor',
  );
});

test('fail-closed doc contract: missing / unknown / illegal / worker-writable / explicit off', () => {
  // Documentation-level fixture notes encoded as executable expectations
  // for a future resolver. This test does not provide a production resolver.
  const failClosedInputs = [
    { name: 'missing context', ctx: null, explicitOff: false },
    { name: 'missing source', ctx: {}, explicitOff: false },
    { name: 'unknown source', ctx: { source: 'something_else' }, explicitOff: false },
    { name: 'illegal empty string', ctx: { source: '' }, explicitOff: false },
    { name: 'illegal type', ctx: { source: ['independent_swarm'] }, explicitOff: false },
    {
      name: 'worker-writable metadata only',
      ctx: null,
      metadata: { handoffSource: 'independent_swarm', enabled: true },
      explicitOff: false,
    },
    {
      name: 'explicit off wins over trusted independent_swarm',
      ctx: { source: 'independent_swarm' },
      explicitOff: true,
    },
    {
      name: 'flywheel source stays closed on knife 3',
      ctx: { source: 'flywheel' },
      explicitOff: false,
    },
  ];

  for (const row of failClosedInputs) {
    const trustedExact =
      row.ctx &&
      row.ctx.source === 'independent_swarm' &&
      row.explicitOff !== true;
    // Prep / tip: even a trusted exact match must stay closed.
    const wouldOpenOnThisPrep = false;
    assert.equal(
      Boolean(trustedExact) && wouldOpenOnThisPrep,
      false,
      `${row.name} must not open handoff on this prep tree`,
    );
    if (row.metadata) {
      assert.equal(
        row.metadata.handoffSource === 'independent_swarm',
        true,
        'fixture constructed correctly',
      );
    }
  }
});

test('skipped until knife-3 entry is opened: trusted independent_swarm may enable', { skip: true }, () => {
  assert.fail('do not unskip until the approved Swarm host entry is open and fail-closed cases still pass');
});

test('rollback / persisted auto sessions stay on knife-2 policy when Swarm entry closes', { skip: true }, () => {
  // Wait for knife-2 persist shape. Behaviour lock:
  // - auto_policy / explicit_on ordinary sessions keep running handoff
  // - explicit_off / old-session default stay off
  // - closing the Swarm entry must not rewrite those records
  assert.fail('replace stub with knife-2 persist records after merge');
});

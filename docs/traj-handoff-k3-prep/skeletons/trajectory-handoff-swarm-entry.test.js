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

/**
 * Prep-tree stand-in only. Not a production resolver and not a Pattern B primitive.
 * On this tree every input stays closed (`open: false`). Reasons name which
 * closed case matched so the table is not a single hardcoded boolean.
 *
 * Priority: explicit off, missing context / worker-writable metadata,
 * flywheel source, orchestrationRunId, missing or inexact source, then an
 * exact trusted `independent_swarm` that is still closed because the entry is.
 */
function closedEntryDecision(input) {
  const row = input && typeof input === 'object' ? input : {};
  const ctx = row.ctx;
  const metadata = row.metadata;
  const orchestrationRunId =
    row.orchestrationRunId ??
    (ctx && typeof ctx === 'object' ? ctx.orchestrationRunId : undefined);

  if (row.explicitOff === true) {
    return { open: false, reason: 'explicit off wins' };
  }
  if (ctx == null) {
    const workerWroteClaim =
      metadata != null &&
      (Object.prototype.hasOwnProperty.call(metadata, 'handoffSource') ||
        metadata.enabled === true);
    if (workerWroteClaim) {
      return { open: false, reason: 'worker-writable metadata ignored' };
    }
    return { open: false, reason: 'missing context' };
  }
  if (ctx.source === 'flywheel') {
    return { open: false, reason: 'flywheel source' };
  }
  if (orchestrationRunId != null && orchestrationRunId !== '') {
    return { open: false, reason: 'orchestrationRunId present' };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx, 'source')) {
    return { open: false, reason: 'missing source' };
  }
  if (ctx.source !== 'independent_swarm') {
    return { open: false, reason: 'inexact source' };
  }
  return { open: false, reason: 'trusted-but-entry-still-closed' };
}

/**
 * Identity over a stub array. Closing the Swarm entry must not rewrite
 * ordinary-session enablement. Does not touch disk and does not import persist.ts.
 * auto_policy / explicit_on stay as given; explicit_off and parser_default stay
 * off; missing capabilityTiers is not flipped to enabled.
 */
function swarmEntryRollbackLeavesOrdinarySessions(records) {
  return records.map((row) => ({ ...row }));
}


test('fail-closed doc contract: missing / unknown / illegal / worker-writable / explicit off', () => {
  const failClosedInputs = [
    { name: 'missing context', ctx: null, explicitOff: false, reason: 'missing context' },
    { name: 'missing source', ctx: {}, explicitOff: false, reason: 'missing source' },
    {
      name: 'unknown source',
      ctx: { source: 'something_else' },
      explicitOff: false,
      reason: 'inexact source',
    },
    { name: 'illegal empty string', ctx: { source: '' }, explicitOff: false, reason: 'inexact source' },
    {
      name: 'illegal type',
      ctx: { source: ['independent_swarm'] },
      explicitOff: false,
      reason: 'inexact source',
    },
    {
      name: 'Independent_Swarm',
      ctx: { source: 'Independent_Swarm' },
      explicitOff: false,
      reason: 'inexact source',
    },
    {
      name: 'padded string',
      ctx: { source: ' independent_swarm ' },
      explicitOff: false,
      reason: 'inexact source',
    },
    { name: 'numeric source', ctx: { source: 1 }, explicitOff: false, reason: 'inexact source' },
    {
      name: 'object source',
      ctx: { source: { kind: 'independent_swarm' } },
      explicitOff: false,
      reason: 'inexact source',
    },
    {
      name: 'worker-writable metadata only',
      ctx: null,
      metadata: { handoffSource: 'independent_swarm', enabled: true },
      explicitOff: false,
      reason: 'worker-writable metadata ignored',
    },
    {
      name: 'explicit off wins over trusted independent_swarm',
      ctx: { source: 'independent_swarm' },
      explicitOff: true,
      reason: 'explicit off wins',
    },
    {
      name: 'flywheel source stays closed on knife 3',
      ctx: { source: 'flywheel' },
      explicitOff: false,
      reason: 'flywheel source',
    },
    {
      name: 'orchestrationRunId with no source',
      ctx: {},
      orchestrationRunId: 'orch-1',
      explicitOff: false,
      reason: 'orchestrationRunId present',
    },
    {
      name: 'exact trusted independent_swarm still closed on this prep',
      ctx: { source: 'independent_swarm' },
      explicitOff: false,
      reason: 'trusted-but-entry-still-closed',
    },
  ];

  for (const row of failClosedInputs) {
    const decision = closedEntryDecision(row);
    assert.equal(decision.open, false, `${row.name} must not open handoff on this prep tree`);
    assert.equal(decision.reason, row.reason, row.name);
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

test('live: swarm-entry rollback does not rewrite ordinary-session enablement', () => {
  const before = [
    {
      sessionId: 's-auto',
      enablementSource: 'auto_policy',
      enabled: true,
      capabilityTiers: { planner: 'p', executor: 'e' },
    },
    {
      sessionId: 's-on',
      enablementSource: 'explicit_on',
      enabled: true,
      capabilityTiers: { planner: 'p' },
    },
    {
      sessionId: 's-off',
      enablementSource: 'explicit_off',
      enabled: false,
      capabilityTiers: { planner: 'p' },
    },
    { sessionId: 's-parser', enablementSource: 'parser_default', enabled: false },
    { sessionId: 's-missing-tiers', enablementSource: 'parser_default', enabled: false },
  ];
  assert.equal(before.find((row) => row.enablementSource === 'auto_policy').enabled, true);
  assert.equal(before.find((row) => row.enablementSource === 'explicit_on').enabled, true);
  assert.equal('capabilityTiers' in before.find((row) => row.sessionId === 's-missing-tiers'), false);

  const after = swarmEntryRollbackLeavesOrdinarySessions(before);
  assert.deepEqual(after, before);

  for (const row of after) {
    const given = before.find((item) => item.sessionId === row.sessionId);
    if (row.enablementSource === 'auto_policy' || row.enablementSource === 'explicit_on') {
      assert.equal(row.enabled, given.enabled, `${row.sessionId} stays as given`);
    }
    if (row.enablementSource === 'explicit_off' || row.enablementSource === 'parser_default') {
      assert.equal(row.enabled, false, `${row.sessionId} stays off`);
    }
    if (!Object.prototype.hasOwnProperty.call(row, 'capabilityTiers')) {
      assert.equal(row.enabled, false, 'missing capabilityTiers is not flipped to enabled');
      assert.equal(Object.prototype.hasOwnProperty.call(given, 'capabilityTiers'), false);
    }
  }
});

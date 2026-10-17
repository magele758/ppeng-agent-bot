import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { acquireFdLock } from '@ppeng/agent-core';
import { claimInboundEvent, InboundClaimTimeoutError, resetInboundDedupe } from '../dist/inbound-guard.js';

const fast = { staleMs: 50, waitMs: 40, attempts: 1 };

function gatewayDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockDb(dir) {
  return join(dir, 'inbound-dedupe.json.lock.db');
}

test('persisted claim acquires and records the id', async () => {
  const dir = gatewayDir('claim-lock-ok-');
  try {
    resetInboundDedupe();
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'duplicate');
    const claims = JSON.parse(readFileSync(join(dir, 'inbound-dedupe.json'), 'utf8'));
    assert.equal(claims.claims.k, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a leftover path lock is ignored and the claim proceeds', async () => {
  const dir = gatewayDir('claim-lock-legacy-');
  try {
    const legacy = join(dir, 'inbound-dedupe.json.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(legacy, '');
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(readFileSync(legacy, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held claim lock throws a retryable timeout, not a duplicate', async () => {
  const dir = gatewayDir('claim-lock-held-');
  try {
    const held = await acquireFdLock(lockDb(dir), { waitMs: 1_000, timeout: 'holder' });
    const error = await claimInboundEvent('k', 1, dir, fast).then(
      () => assert.fail('expected timeout'),
      (caught) => caught
    );
    assert.equal(error instanceof InboundClaimTimeoutError, true);
    assert.equal(error.retryable, true);
    assert.equal(error.code, 'INBOUND_CLAIM_TIMEOUT');
    assert.match(error.message, /Inbound claim lock timed out: .*inbound-dedupe\.json\.lock$/);
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
    held.release();
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim that throws still releases its lock', async () => {
  const dir = gatewayDir('claim-lock-throw-');
  try {
    await assert.rejects(
      () => claimInboundEvent('k', 1, dir, {
        ...fast,
        onAcquired: () => {
          const error = new Error('claim failed');
          error.code = 'EIO';
          throw error;
        }
      }),
      (error) => error && error.code === 'EIO'
    );
    assert.equal(await claimInboundEvent('k', 2, dir, fast), 'claimed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-directory persist path is rethrown', async () => {
  const dir = gatewayDir('claim-lock-eacces-');
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  await assert.rejects(
    () => claimInboundEvent('k', 1, join(blocker, 'child'), fast),
    (error) => error && (error.code === 'ENOTDIR' || error.code === 'EEXIST')
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a jumped clock cannot postpone the wait deadline', async () => {
  const dir = gatewayDir('claim-lock-deadline-');
  try {
    const held = await acquireFdLock(lockDb(dir), { waitMs: 1_000, timeout: 'holder' });
    let reads = 0;
    const base = 10_000;
    const started = Date.now();
    await assert.rejects(
      () => claimInboundEvent('k', 1, dir, {
        staleMs: 0,
        waitMs: 10,
        attempts: 1,
        now: () => {
          reads += 1;
          return reads === 1 ? base : base + 100;
        }
      }),
      (error) => error instanceof InboundClaimTimeoutError
    );
    assert.ok(Date.now() - started < 1_000);
    assert.ok(reads < 20);
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
    held.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two claim callers in one process cannot both win', async () => {
  const dir = gatewayDir('claim-lock-serial-');
  try {
    resetInboundDedupe();
    let releaseHold;
    const hold = new Promise((resolve) => { releaseHold = resolve; });
    const first = claimInboundEvent('k', 1, dir, {
      waitMs: 1_000,
      attempts: 1,
      onAcquired: () => releaseHold()
    });
    await hold;
    const second = claimInboundEvent('k', 1, dir, { waitMs: 1_000, attempts: 1 });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([a, b].sort(), ['claimed', 'duplicate']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

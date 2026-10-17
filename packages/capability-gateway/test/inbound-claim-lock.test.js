import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { claimInboundEvent, InboundClaimTimeoutError, resetInboundDedupe } from '../dist/inbound-guard.js';

const fast = { staleMs: 50, waitMs: 30, attempts: 1 };

function gatewayDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockOf(dir) {
  return join(dir, 'inbound-dedupe.json.lock');
}

test('persisted claim acquires and releases the lock file', async () => {
  const dir = gatewayDir('claim-lock-ok-');
  try {
    resetInboundDedupe();
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(existsSync(lockOf(dir)), false);
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh empty lock is not stolen and the wait throws a timeout, not a duplicate', async () => {
  const dir = gatewayDir('claim-lock-empty-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, '');
    await assert.rejects(
      () => claimInboundEvent('k', 1, dir, fast),
      (error) => error instanceof InboundClaimTimeoutError && error.retryable === true
    );
    assert.equal(readFileSync(lock, 'utf8'), '');
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old-mtime lock is reclaimed and the claim proceeds', async () => {
  const dir = gatewayDir('claim-lock-stale-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'leftover');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(existsSync(lock), false);
    const claims = JSON.parse(readFileSync(join(dir, 'inbound-dedupe.json'), 'utf8'));
    assert.equal(claims.claims.k, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim that throws still releases its own lock', async () => {
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
    assert.equal(existsSync(lockOf(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release does not delete a lock a later owner replaced', async () => {
  const dir = gatewayDir('claim-lock-owner-');
  try {
    assert.equal(await claimInboundEvent('k', 1, dir, {
      ...fast,
      onAcquired: (lockPath) => writeFileSync(lockPath, 'other-owner')
    }), 'claimed');
    assert.equal(readFileSync(lockOf(dir), 'utf8'), 'other-owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-EEXIST open error is rethrown', async () => {
  const dir = gatewayDir('claim-lock-eacces-');
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const missing = join(blocker, 'child');
  await assert.rejects(
    () => claimInboundEvent('k', 1, missing, fast),
    (error) => error && (error.code === 'ENOTDIR' || error.code === 'EEXIST')
  );
  rmSync(dir, { recursive: true, force: true });
});

test('a stale lock cannot postpone the wait deadline', async () => {
  const dir = gatewayDir('claim-lock-deadline-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'leftover');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
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
    assert.equal(readFileSync(lock, 'utf8'), 'leftover');
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock timeout is not reported as a duplicate', async () => {
  const dir = gatewayDir('claim-lock-busy-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'holder');
    const error = await claimInboundEvent('k', 1, dir, fast).then(
      () => assert.fail('expected timeout'),
      (caught) => caught
    );
    assert.equal(error instanceof InboundClaimTimeoutError, true);
    assert.equal(error.retryable, true);
    assert.notEqual(error, 'duplicate');
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
    writeFileSync(join(dir, 'inbound-dedupe.json'), JSON.stringify({ version: 1, claims: { k: 1 } }));
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

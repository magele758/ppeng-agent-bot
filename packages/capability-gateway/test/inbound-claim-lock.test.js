import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { claimInboundEvent, resetInboundDedupe } from '../dist/inbound-guard.js';

const fast = { staleMs: 50, waitMs: 30 };

function gatewayDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockOf(dir) {
  return join(dir, 'inbound-dedupe.json.lock');
}

test('persisted claim acquires and releases the lock file', () => {
  const dir = gatewayDir('claim-lock-ok-');
  try {
    resetInboundDedupe();
    assert.equal(claimInboundEvent('k', 1, dir, fast), true);
    assert.equal(existsSync(lockOf(dir)), false);
    assert.equal(claimInboundEvent('k', 1, dir, fast), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh empty lock is not stolen and the wait returns false', () => {
  const dir = gatewayDir('claim-lock-empty-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, '');
    assert.equal(claimInboundEvent('k', 1, dir, fast), false);
    assert.equal(readFileSync(lock, 'utf8'), '');
    assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old-mtime lock is reclaimed and the claim proceeds', () => {
  const dir = gatewayDir('claim-lock-stale-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'leftover');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.equal(claimInboundEvent('k', 1, dir, fast), true);
    assert.equal(existsSync(lock), false);
    const claims = JSON.parse(readFileSync(join(dir, 'inbound-dedupe.json'), 'utf8'));
    assert.equal(claims.claims.k, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim that throws still releases its own lock', () => {
  const dir = gatewayDir('claim-lock-throw-');
  try {
    assert.throws(
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

test('release does not delete a lock a later owner replaced', () => {
  const dir = gatewayDir('claim-lock-owner-');
  try {
    assert.equal(claimInboundEvent('k', 1, dir, {
      ...fast,
      onAcquired: (lockPath) => writeFileSync(lockPath, 'other-owner')
    }), true);
    assert.equal(readFileSync(lockOf(dir), 'utf8'), 'other-owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-EEXIST open error is rethrown', () => {
  const dir = gatewayDir('claim-lock-eacces-');
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const missing = join(blocker, 'child');
  assert.throws(
    () => claimInboundEvent('k', 1, missing, fast),
    (error) => error && (error.code === 'ENOTDIR' || error.code === 'EEXIST')
  );
  rmSync(dir, { recursive: true, force: true });
});

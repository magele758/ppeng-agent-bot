import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createLockToken, readProcStartTime, releaseHeldLock } from '@ppeng/agent-core';
import { claimInboundEvent, InboundClaimTimeoutError, resetInboundDedupe } from '../dist/inbound-guard.js';

const fast = { staleMs: 50, waitMs: 30, attempts: 1 };

function gatewayDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lockOf(dir) {
  return join(dir, 'inbound-dedupe.json.lock');
}

function age(file, msAgo) {
  const old = new Date(Date.now() - msAgo);
  utimesSync(file, old, old);
}

/** A pid that existed, then exited, so it is verifiably dead. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  return child.pid;
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

test('a dead pid lock is reclaimed and the claim proceeds', async () => {
  const dir = gatewayDir('claim-lock-stale-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, `${deadPid()}:1`);
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(existsSync(lock), false);
    const claims = JSON.parse(readFileSync(join(dir, 'inbound-dedupe.json'), 'utf8'));
    assert.equal(claims.claims.k, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old lock with no pid is reclaimed once its mtime is stale', async () => {
  const dir = gatewayDir('claim-lock-nopid-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'leftover');
    age(lock, 60_000);
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh lock with no pid is not reclaimed', async () => {
  const dir = gatewayDir('claim-lock-nopid-fresh-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'leftover');
    await assert.rejects(
      () => claimInboundEvent('k', 1, dir, fast),
      (error) => error instanceof InboundClaimTimeoutError
    );
    assert.equal(readFileSync(lock, 'utf8'), 'leftover');
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
    age(lock, 60_000);
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

test('a live holder with an aged mtime is not reclaimed and the wait times out', async () => {
  const dir = gatewayDir('claim-lock-paused-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    const token = createLockToken();
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, token);
    age(lock, 60_000);
    try {
      await assert.rejects(
        () => claimInboundEvent('k', 1, dir, fast),
        (error) => error instanceof InboundClaimTimeoutError && error.retryable === true
      );
      assert.equal(readFileSync(lock, 'utf8'), token);
      assert.equal(existsSync(join(dir, 'inbound-dedupe.json')), false);
    } finally {
      releaseHeldLock(lock, fd, token);
    }
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live foreign pid with a matching start time is not reclaimed', { skip: process.platform === 'linux' ? false : 'start time is only readable on Linux' }, async () => {
  const dir = gatewayDir('claim-lock-foreign-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    const start = readProcStartTime(process.ppid);
    assert.match(start, /^\d+$/);
    const body = `${process.ppid}:${start}:${'ab'.repeat(8)}:foreign`;
    writeFileSync(lock, body);
    age(lock, 60_000);
    await assert.rejects(
      () => claimInboundEvent('k', 1, dir, fast),
      (error) => error instanceof InboundClaimTimeoutError
    );
    assert.equal(readFileSync(lock, 'utf8'), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('our own pid with a foreign token is reclaimed', async () => {
  const dir = gatewayDir('claim-lock-reuse-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, `${process.pid}:1:not-our-token:nonce`);
    assert.equal(await claimInboundEvent('k', 1, dir, fast), 'claimed');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale holder releasing does not delete the lock a new holder created', () => {
  const dir = gatewayDir('claim-lock-replaced-');
  try {
    const lock = lockOf(dir);
    mkdirSync(dir, { recursive: true });
    const staleFd = openSync(lock, 'wx');
    writeFileSync(staleFd, 'holder-a');
    rmSync(lock);
    const freshFd = openSync(lock, 'wx');
    writeFileSync(freshFd, 'holder-b');
    releaseHeldLock(lock, staleFd, 'holder-a');
    assert.equal(readFileSync(lock, 'utf8'), 'holder-b');
    closeSync(freshFd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

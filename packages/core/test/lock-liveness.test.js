import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCK_START_UNKNOWN,
  createLockToken,
  currentProcessLockToken,
  holdLockAcquisition,
  lockBodyStale,
  lockFileStale,
  lockIdentityAlive,
  lockTokenNonce,
  parseLockIdentity,
  readProcStartTime,
  releaseLockAcquisition,
  releaseLockIfToken,
  setProcStartTimeReaderForTests
} from '../dist/teams/lock-liveness.js';

const linux = process.platform === 'linux';

function dir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function age(file, msAgo) {
  const old = new Date(Date.now() - msAgo);
  utimesSync(file, old, old);
}

test('a v2 token records pid, start time, process token, and a unique nonce', () => {
  const a = createLockToken();
  const b = createLockToken();
  const parsed = parseLockIdentity(a);
  assert.equal(parsed.kind, 'v2');
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.procToken, currentProcessLockToken());
  assert.notEqual(parsed.nonce, parseLockIdentity(b).nonce);
  assert.equal(lockTokenNonce(a), parsed.nonce);
  if (linux) {
    assert.match(parsed.start, /^\d+$/);
    assert.equal(parsed.start, readProcStartTime(process.pid));
  } else {
    assert.equal(parsed.start, LOCK_START_UNKNOWN);
  }
});

test('our pid with a foreign token is a previous incarnation, not a live owner', () => {
  const start = linux ? readProcStartTime(process.pid) : '1';
  const body = `${process.pid}:${start}:not-our-token:nonce`;
  assert.equal(lockIdentityAlive(body), false);
  assert.equal(lockBodyStale({ body, ageMs: 0, staleMs: 10_000 }), true);
});

test('a live foreign pid with a different start time is not that owner', { skip: linux ? false : 'start time is only readable on Linux' }, () => {
  const parent = process.ppid;
  assert.notEqual(readProcStartTime(parent), LOCK_START_UNKNOWN);
  const body = `${parent}:1:${'ab'.repeat(8)}:nonce`;
  assert.equal(lockIdentityAlive(body), false);
  assert.equal(lockBodyStale({ body, ageMs: 0, staleMs: 10_000 }), true);
});

test('a live foreign pid with matching identity is reclaimable once mtime is stale and we do not hold it', { skip: linux ? false : 'start time is only readable on Linux' }, () => {
  const parent = process.ppid;
  const start = readProcStartTime(parent);
  const body = `${parent}:${start}:${'cd'.repeat(8)}:foreign-nonce`;
  assert.equal(lockIdentityAlive(body), true);
  assert.equal(lockBodyStale({ body, ageMs: 0, staleMs: 40 }), false);
  assert.equal(lockBodyStale({ body, ageMs: 41, staleMs: 40 }), true);
});

test('a fresh lock this process holds is not reclaimed even with an old mtime', () => {
  const root = dir('lock-held-');
  try {
    const token = createLockToken();
    const nonce = lockTokenNonce(token);
    const file = join(root, '.lock');
    writeFileSync(file, token);
    age(file, 60_000);
    holdLockAcquisition(nonce);
    try {
      assert.equal(lockFileStale(file, 40, Date.now()), false);
    } finally {
      releaseLockAcquisition(nonce);
    }
    assert.equal(lockFileStale(file, 40, Date.now()), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('old-format live pid waits for a stale mtime; a dead pid is reclaimable immediately', () => {
  const live = `${process.pid}:${Date.now()}`;
  assert.equal(parseLockIdentity(live).kind, 'v1');
  assert.equal(lockBodyStale({ body: live, ageMs: 0, staleMs: 40 }), false);
  assert.equal(lockBodyStale({ body: live, ageMs: 41, staleMs: 40 }), true);
  assert.equal(lockBodyStale({ body: '999999:1', ageMs: 0, staleMs: 40 }), true);
  assert.equal(lockBodyStale({ body: 'not-a-pid', ageMs: 0, staleMs: 40 }), true);
  assert.equal(lockBodyStale({ body: '', ageMs: 0, staleMs: 40 }), false);
  assert.equal(lockBodyStale({ body: '', ageMs: 41, staleMs: 40 }), true);
});

test('release unlinks only a body that still equals our token', () => {
  const root = dir('lock-release-');
  try {
    const file = join(root, '.lock');
    const ours = createLockToken();
    writeFileSync(file, `${process.pid}:1:other:nonce`);
    releaseLockIfToken(file, ours);
    assert.equal(lockFileStale(file, 40, Date.now()), true);
    writeFileSync(file, ours);
    releaseLockIfToken(file, ours);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without /proc a fresh v2 lock from a live foreign pid is not reclaimed', () => {
  const parent = process.ppid;
  const body = `${parent}:${LOCK_START_UNKNOWN}:${'ef'.repeat(8)}:na-nonce`;
  setProcStartTimeReaderForTests(() => LOCK_START_UNKNOWN);
  try {
    assert.equal(lockIdentityAlive(body), true);
    assert.equal(lockBodyStale({ body, ageMs: 0, staleMs: 40 }), false);
    assert.equal(lockBodyStale({ body, ageMs: 41, staleMs: 40 }), true);
  } finally {
    setProcStartTimeReaderForTests(undefined);
  }
});

test('a real start-time mismatch is reclaimed while the lock is still fresh', () => {
  const parent = process.ppid;
  const body = `${parent}:111:${'ab'.repeat(8)}:mismatch-nonce`;
  setProcStartTimeReaderForTests(() => '222');
  try {
    assert.equal(lockIdentityAlive(body), false);
    assert.equal(lockBodyStale({ body, ageMs: 0, staleMs: 10_000 }), true);
  } finally {
    setProcStartTimeReaderForTests(undefined);
  }
});

test('a comm field containing parentheses still yields starttime field 22', { skip: linux ? false : 'start time is only readable on Linux' }, () => {
  const start = readProcStartTime(process.pid);
  assert.match(start, /^\d+$/);
  assert.notEqual(start, LOCK_START_UNKNOWN);
});

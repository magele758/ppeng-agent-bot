import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyWorkspaceSnapshot, snapshotLockWaitMs, syncWorkerResultToPlan } from '../dist/teams/workspace-sync.js';
import { SNAPSHOT_LOCK_HEARTBEAT_MS, startSnapshotLockHeartbeat } from '../dist/teams/snapshot-lock.js';

const fast = { staleMs: 40, waitMs: 30 };

function root(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ageLock(lock, msAgo) {
  const old = new Date(Date.now() - msAgo);
  utimesSync(lock, old, old);
}

test('a stale snapshot lock is reclaimed and the copy completes', async () => {
  const dir = root('snap-stale-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'yes');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, 'not-a-pid');
    ageLock(lock, 60_000);
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'yes');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead-pid snapshot lock is reclaimed', async () => {
  const dir = root('snap-dead-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'after-crash');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, '999999:crashed');
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'after-crash');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh live snapshot lock is not stolen', async () => {
  const dir = root('snap-live-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'no');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, `${process.pid}:live`);
    await assert.rejects(() => copyWorkspaceSnapshot(src, dest, fast), /Team workspace snapshot lock timed out/);
    assert.equal(existsSync(join(dest, 'kept.txt')), false);
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid}:live`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncWorkerResultToPlan reclaims a crash leftover instead of dropping the result', async () => {
  const dir = root('snap-sync-');
  try {
    const worker = join(dir, 'worker');
    const integration = join(dir, 'integration');
    mkdirSync(worker, { recursive: true });
    mkdirSync(integration, { recursive: true });
    writeFileSync(join(worker, 'result.txt'), 'shipped');
    const lock = join(integration, '.snapshot.lock');
    writeFileSync(lock, '');
    ageLock(lock, 60_000);
    await syncWorkerResultToPlan(worker, integration, fast);
    assert.equal(readFileSync(join(integration, 'result.txt'), 'utf8'), 'shipped');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

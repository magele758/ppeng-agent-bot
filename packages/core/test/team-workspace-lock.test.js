import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyWorkspaceSnapshot, snapshotLockWaitMs, syncWorkerResultToPlan } from '../dist/teams/workspace-sync.js';
import { SNAPSHOT_LOCK_HEARTBEAT_MS, SNAPSHOT_LOCK_STALE_MS, startSnapshotLockHeartbeat, withSnapshotLock } from '../dist/teams/snapshot-lock.js';
import { acquireFdLock } from '../dist/teams/fd-lock.js';

const fast = { staleMs: 40, waitMs: 40 };

function root(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('a leftover path lock does not block a snapshot copy', async () => {
  const dir = root('snap-legacy-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'yes');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, 'not-a-pid');
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'yes');
    assert.equal(readFileSync(lock, 'utf8'), 'not-a-pid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held snapshot lock times out instead of copying', async () => {
  const dir = root('snap-held-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'no');
    const held = await acquireFdLock(join(dest, '.snapshot.lock.db'), { waitMs: 1_000, timeout: 'holder' });
    await assert.rejects(() => copyWorkspaceSnapshot(src, dest, fast), /Team workspace snapshot lock timed out/);
    assert.equal(existsSync(join(dest, 'kept.txt')), false);
    held.release();
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'no');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two snapshot callers in one process run one at a time', async () => {
  const dir = root('snap-serial-');
  try {
    const dest = join(dir, 'dest');
    const order = [];
    const first = withSnapshotLock(dest, async () => {
      order.push('first-enter');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first-leave');
    }, { waitMs: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withSnapshotLock(dest, async () => {
      order.push('second-enter');
    }, { waitMs: 1_000 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-enter', 'first-leave', 'second-enter']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncWorkerResultToPlan copies past a leftover path lock', async () => {
  const dir = root('snap-sync-');
  try {
    const worker = join(dir, 'worker');
    const integration = join(dir, 'integration');
    mkdirSync(worker, { recursive: true });
    mkdirSync(integration, { recursive: true });
    writeFileSync(join(worker, 'result.txt'), 'shipped');
    writeFileSync(join(integration, '.snapshot.lock'), '');
    await syncWorkerResultToPlan(worker, integration, fast);
    assert.equal(readFileSync(join(integration, 'result.txt'), 'utf8'), 'shipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot heartbeat is a deprecated no-op and wait env still applies', () => {
  const stop = startSnapshotLockHeartbeat('/unused', 30);
  stop();
  assert.equal(SNAPSHOT_LOCK_HEARTBEAT_MS, 2_500);
  assert.equal(SNAPSHOT_LOCK_STALE_MS, 10_000);
  const previous = process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS;
  delete process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS;
  try {
    assert.equal(snapshotLockWaitMs(), 15_000);
    process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS = '250';
    assert.equal(snapshotLockWaitMs(), 250);
    process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS = 'nope';
    assert.equal(snapshotLockWaitMs(), 15_000);
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS;
    else process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS = previous;
  }
});

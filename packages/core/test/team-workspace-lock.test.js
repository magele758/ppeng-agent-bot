import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyWorkspaceSnapshot, snapshotLockWaitMs, syncWorkerResultToPlan } from '../dist/teams/workspace-sync.js';
import { SNAPSHOT_LOCK_HEARTBEAT_MS, startSnapshotLockHeartbeat, withSnapshotLock } from '../dist/teams/snapshot-lock.js';
import { setLockRenameForTests } from '../dist/teams/lock-liveness.js';

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

test('reclaiming a dead snapshot lock does not leave a parked file', async () => {
  const dir = root('snap-parked-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'yes');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, '999999:crashed');
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(existsSync(lock), false);
    const parked = readdirSync(dest).filter((name) => name.includes('.reclaim'));
    assert.deepEqual(parked, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh old-format snapshot lock with a live pid is not reclaimed', async () => {
  const dir = root('snap-v1-fresh-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'no');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, `${process.pid}:${Date.now()}`);
    await assert.rejects(() => copyWorkspaceSnapshot(src, dest, fast), /Team workspace snapshot lock timed out/);
    assert.equal(existsSync(join(dest, 'kept.txt')), false);
    assert.match(readFileSync(lock, 'utf8'), new RegExp(`^${process.pid}:\\d+$`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old-format snapshot lock with a live pid is reclaimed once its mtime is stale', async () => {
  const dir = root('snap-v1-stale-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'after-v1');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, `${process.pid}:${Date.now()}`);
    ageLock(lock, 60_000);
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'after-v1');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('our pid with a foreign token and an old mtime is reclaimed without waiting out the timeout', async () => {
  const dir = root('snap-reuse-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'reused');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, `${process.pid}:1:deadbeefsnap:noncesnap`);
    ageLock(lock, 60_000);
    const started = Date.now();
    await copyWorkspaceSnapshot(src, dest, fast);
    assert.ok(Date.now() - started < 500);
    assert.equal(readFileSync(join(dest, 'kept.txt'), 'utf8'), 'reused');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot lock this process holds is not reclaimed when its mtime is aged', async () => {
  const dir = root('snap-held-');
  try {
    const dest = join(dir, 'dest');
    mkdirSync(dest, { recursive: true });
    const lock = join(dest, '.snapshot.lock');
    let releaseHold;
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const held = withSnapshotLock(dest, async () => {
      ageLock(lock, 60_000);
      await hold;
    }, { staleMs: 40, waitMs: 2_000, startHeartbeat: () => () => {} });
    const copy = withSnapshotLock(dest, async () => 'stole', fast).then(
      (value) => value,
      () => 'waited'
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    releaseHold();
    await held;
    assert.equal(await copy, 'waited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot release removes only the body this process wrote', async () => {
  const dir = root('snap-release-');
  try {
    const dest = join(dir, 'dest');
    mkdirSync(dest, { recursive: true });
    const lock = join(dest, '.snapshot.lock');
    const replaced = `${process.pid}:1:foreign:notours`;
    let releaseHold;
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const held = withSnapshotLock(dest, async () => {
      writeFileSync(lock, replaced);
      await hold;
    }, { staleMs: 40, waitMs: 2_000, startHeartbeat: () => () => {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseHold();
    await held;
    assert.equal(readFileSync(lock, 'utf8'), replaced);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale snapshot holder releasing does not delete the lock a new holder created', async () => {
  const dir = root('snap-successor-');
  try {
    const dest = join(dir, 'dest');
    mkdirSync(dest, { recursive: true });
    const lock = join(dest, '.snapshot.lock');
    const successor = `${process.pid}:1:deadbeefnext:noncenext`;
    let releaseHold;
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const held = withSnapshotLock(dest, async () => {
      ageLock(lock, 60_000);
      rmSync(lock);
      writeFileSync(lock, successor);
      await hold;
    }, { staleMs: 40, waitMs: 2_000, startHeartbeat: () => () => {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseHold();
    await held;
    assert.equal(readFileSync(lock, 'utf8'), successor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot rename that keeps failing throws the lock timeout', async () => {
  const dir = root('snap-rename-');
  try {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, 'kept.txt'), 'no');
    const lock = join(dest, '.snapshot.lock');
    writeFileSync(lock, '999999:crashed');
    ageLock(lock, 60_000);
    setLockRenameForTests(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const started = Date.now();
    await assert.rejects(() => copyWorkspaceSnapshot(src, dest, { staleMs: 40, waitMs: 80 }), /Team workspace snapshot lock timed out/);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(existsSync(join(dest, 'kept.txt')), false);
    assert.equal(readFileSync(lock, 'utf8'), '999999:crashed');
  } finally {
    setLockRenameForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot heartbeat refreshes mtime and stops when cleared', async () => {
  const dir = root('snap-beat-');
  try {
    const lock = join(dir, '.snapshot.lock');
    writeFileSync(lock, 'held');
    ageLock(lock, 60_000);
    const aged = statSync(lock).mtimeMs;
    const stop = startSnapshotLockHeartbeat(lock, 30);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
    const touched = statSync(lock).mtimeMs;
    assert.ok(touched > aged);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(statSync(lock).mtimeMs, touched);
    assert.equal(SNAPSHOT_LOCK_HEARTBEAT_MS, 2_500);
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

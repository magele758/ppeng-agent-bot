import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFdLock, isSqliteLockBusy, withFdLock } from '../dist/teams/fd-lock.js';

const CORE = join(import.meta.dirname, '../dist/teams/fd-lock.js');
const MAILBOX = join(import.meta.dirname, '../dist/teams/mailbox.js');
const SNAPSHOT = join(import.meta.dirname, '../dist/teams/snapshot-lock.js');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('isSqliteLockBusy matches busy and locked codes only', () => {
  assert.equal(isSqliteLockBusy({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), true);
  assert.equal(isSqliteLockBusy({ code: 'ERR_SQLITE_ERROR', errcode: 517 }), true);
  assert.equal(isSqliteLockBusy({ code: 'SQLITE_LOCKED' }), true);
  assert.equal(isSqliteLockBusy({ code: 'ERR_SQLITE_ERROR', errcode: 1 }), false);
  assert.equal(isSqliteLockBusy(null), false);
});

test('release is idempotent and a second caller then acquires', async () => {
  const dir = tempDir('fdlock-release-');
  try {
    const db = join(dir, 'a.lock.db');
    const held = await acquireFdLock(db, { waitMs: 200, timeout: 'timeout' });
    held.release();
    held.release();
    const again = await acquireFdLock(db, { waitMs: 200, timeout: 'timeout' });
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a killed holder releases the lock immediately', async () => {
  const dir = tempDir('fdlock-kill-');
  const db = join(dir, 'a.lock.db');
  const child = spawn(process.execPath, ['--input-type=module', '-e', holdUntilKilled(CORE), db], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForLine(child, 'HELD');
    child.kill('SIGKILL');
    await waitForExit(child);
    const started = Date.now();
    const held = await acquireFdLock(db, { waitMs: 1_000, timeout: 'still held' });
    assert.ok(Date.now() - started < 500);
    held.release();
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blocking the event loop does not let a child take the lock', async () => {
  const dir = tempDir('fdlock-block-');
  const db = join(dir, 'a.lock.db');
  const child = spawn(process.execPath, ['--input-type=module', '-e', waitForLock(CORE), db], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const held = await acquireFdLock(db, { waitMs: 1_000, timeout: 'parent' });
    await waitForLine(child, 'WAITING');
    const until = Date.now() + 12_000;
    while (Date.now() < until) { /* longer than the old stale window */ }
    assert.equal(child.exitCode, null);
    held.release();
    const result = await waitForExit(child);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ACQUIRED/);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent child processes never double-hold mailbox, snapshot, or claim locks', async () => {
  const dir = tempDir('fdlock-race-');
  const workers = 4;
  const cycles = 20;
  try {
    const children = ['mailbox', 'snapshot', 'claim'].flatMap((kind) =>
      Array.from({ length: workers }, (_, index) => spawnWorker(join(dir, kind), kind, index, cycles))
    );
    const timer = setInterval(() => assertNoOverlap(dir), 2);
    let results;
    try {
      results = await Promise.all(children.map(waitForExit));
    } finally {
      clearInterval(timer);
    }
    for (const result of results) assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const kind of ['mailbox', 'snapshot', 'claim']) {
      const count = Number(readFileSync(join(dir, kind, 'count'), 'utf8'));
      assert.equal(count, workers * cycles, kind);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two async callers in one process are serialized', async () => {
  const dir = tempDir('fdlock-serial-');
  try {
    const db = join(dir, 'a.lock.db');
    let inside = 0;
    let overlap = 0;
    await Promise.all(Array.from({ length: 6 }, () => withFdLock(db, async () => {
      inside += 1;
      if (inside > 1) overlap += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    }, { waitMs: 2_000, timeout: 'timeout' })));
    assert.equal(overlap, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function holdUntilKilled(modulePath) {
  return `
    import { acquireFdLock } from ${JSON.stringify(modulePath)};
    await acquireFdLock(process.argv[1], { waitMs: 1_000, timeout: 'no' });
    console.log('HELD');
    setInterval(() => {}, 1_000);
  `;
}

function waitForLock(modulePath) {
  return `
    import { acquireFdLock } from ${JSON.stringify(modulePath)};
    console.log('WAITING');
    const held = await acquireFdLock(process.argv[1], { waitMs: 30_000, timeout: 'child timeout' });
    console.log('ACQUIRED');
    held.release();
  `;
}

function spawnWorker(dir, kind, index, cycles) {
  const code = workerSource(kind);
  return spawn(process.execPath, ['--input-type=module', '-e', code, dir, String(index), String(cycles)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function workerSource(kind) {
  const acquire = {
    mailbox: `import { withMailboxLock } from ${JSON.stringify(MAILBOX)};
      const run = (fn) => withMailboxLock(process.argv[1], fn, { waitMs: 10_000 });`,
    snapshot: `import { withSnapshotLock } from ${JSON.stringify(SNAPSHOT)};
      const run = (fn) => withSnapshotLock(process.argv[1], fn, { waitMs: 10_000 });`,
    claim: `import { withFdLock } from ${JSON.stringify(CORE)};
      const run = (fn) => withFdLock(join(process.argv[1], 'claim.lock.db'), fn, { waitMs: 10_000, timeout: 'claim timeout' });`
  }[kind];
  return `
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    ${acquire}
    const root = process.argv[1];
    const marker = join(root, 'marker-' + process.argv[2]);
    const countFile = join(root, 'count');
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < Number(process.argv[3]); i += 1) {
      await run(() => {
        writeFileSync(marker, '1');
        const count = readCount(countFile) + 1;
        writeFileSync(countFile, String(count));
        writeFileSync(marker, '0');
      });
    }
    function readCount(file) {
      try { return Number(readFileSync(file, 'utf8')); } catch { return 0; }
    }
  `;
}

function waitForLine(child, line) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`missing ${line}: ${stderr}`)), 5_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stdout.includes(line)) return;
      clearTimeout(timer);
      resolve(stdout);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited before ${line}: ${stderr}`));
    });
  });
}

function assertNoOverlap(dir) {
  for (const kind of ['mailbox', 'snapshot', 'claim']) {
    const kindDir = join(dir, kind);
    let held = 0;
    try {
      for (const name of readdirSync(kindDir)) {
        if (!name.startsWith('marker-')) continue;
        if (readFileSync(join(kindDir, name), 'utf8') === '1') held += 1;
      }
    } catch {
      continue;
    }
    if (held > 1) throw new Error(`${kind} had ${held} holders`);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

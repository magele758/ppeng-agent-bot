import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const output = collectOutput(child);
  try {
    const held = await acquireFdLock(db, { waitMs: 1_000, timeout: 'parent' });
    await waitForLine(child, 'WAITING');
    blockEventLoop(12_000);
    await yieldEventLoop();
    assertChildStillWaiting(child, output);
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
    const results = await Promise.all(children.map(waitForExit));
    for (const result of results) assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const kind of ['mailbox', 'snapshot', 'claim']) assertExclusive(join(dir, kind), workers * cycles);
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

/** Longer than the old mtime stale window, so a time-based reclaim would have fired. */
function blockEventLoop(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* synchronous: queued child I/O cannot run */ }
}

/** Drain exit and stdout events that a busy loop left sitting in the queue. */
async function yieldEventLoop() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function assertChildStillWaiting(child, output) {
  assert.equal(child.exitCode, null);
  assert.equal(output.stdout.includes('ACQUIRED'), false, output.stdout);
}

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
    process.stdout.write('WAITING\\n');
    const held = await acquireFdLock(process.argv[1], { waitMs: 30_000, timeout: 'child timeout' });
    process.stdout.write('ACQUIRED\\n');
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
  const acquire = lockAcquire(kind);
  return `
    import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    ${acquire}
    const root = process.argv[1];
    const id = process.argv[2];
    const ownerFile = join(root, 'owner');
    const countFile = join(root, 'count');
    const violations = join(root, 'violations');
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < Number(process.argv[3]); i += 1) {
      await run(() => holdOnce(id, ownerFile, countFile, violations));
    }
    ${sectionHelpers()}
  `;
}

function lockAcquire(kind) {
  if (kind === 'mailbox') {
    return `import { withMailboxLock } from ${JSON.stringify(MAILBOX)};
      const run = (fn) => withMailboxLock(process.argv[1], fn, { waitMs: 10_000 });`;
  }
  if (kind === 'snapshot') {
    return `import { withSnapshotLock } from ${JSON.stringify(SNAPSHOT)};
      const run = (fn) => withSnapshotLock(process.argv[1], fn, { waitMs: 10_000 });`;
  }
  return `import { withFdLock } from ${JSON.stringify(CORE)};
    const run = (fn) => withFdLock(join(process.argv[1], 'claim.lock.db'), fn, { waitMs: 10_000, timeout: 'claim timeout' });`;
}

function sectionHelpers() {
  return `
    function holdOnce(id, ownerFile, countFile, violations) {
      const seen = readText(ownerFile);
      if (seen !== '') noteViolation(violations, id, 'enter', seen);
      writeFileSync(ownerFile, id);
      let spin = 0;
      for (let n = 0; n < 200; n += 1) spin += n;
      const still = readText(ownerFile);
      if (still !== id) noteViolation(violations, id, 'held', still);
      writeFileSync(countFile, String(readCount(countFile) + 1));
      writeFileSync(ownerFile, '');
      if (spin < 0) writeFileSync(ownerFile, 'spin');
    }
    function noteViolation(file, id, when, seen) {
      appendFileSync(file, id + ' ' + when + ' saw ' + JSON.stringify(seen) + '\\n');
    }
    function readText(file) {
      try { return readFileSync(file, 'utf8'); } catch { return ''; }
    }
    function readCount(file) {
      const text = readText(file);
      return text === '' ? 0 : Number(text);
    }
  `;
}

function assertExclusive(dir, expected) {
  assert.equal(Number(readFileSync(join(dir, 'count'), 'utf8')), expected);
  assert.equal(readFileSync(join(dir, 'owner'), 'utf8'), '');
  assert.equal(violationCount(dir), 0);
}

function violationCount(dir) {
  try {
    const text = readFileSync(join(dir, 'violations'), 'utf8').trim();
    return text === '' ? 0 : text.split('\n').length;
  } catch {
    return 0;
  }
}

function waitForLine(child, line) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`missing ${line}: ${stderr}`)), 5_000);
    const onData = (chunk) => {
      stdout += chunk;
      if (!stdout.includes(line)) return;
      cleanup();
      resolve(stdout);
    };
    const onErr = (chunk) => { stderr += chunk; };
    const onExit = () => {
      cleanup();
      reject(new Error(`exited before ${line}: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onErr);
    child.on('exit', onExit);
  });
}

function collectOutput(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  return output;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (child.exitCode !== null) {
      resolve({ status: child.exitCode, stdout, stderr });
      return;
    }
    child.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { lockOwnerDead } from './lock-liveness.js';
import { startAsyncLockWait } from './async-lock-wait.js';

/** Crash leftover with no live owner. Env override is for tests that need a shorter wait. */
export const SNAPSHOT_LOCK_STALE_MS = 10_000;

const DEFAULT_SNAPSHOT_LOCK_WAIT_MS = 15_000;

/** How often a holder refreshes mtime so a live lock is not judged by a stale timestamp. */
export const SNAPSHOT_LOCK_HEARTBEAT_MS = 2_500;

function envWaitMs(): number | undefined {
  const raw = process.env.RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Default wait. Tests pass `waitMs`; ops can shorten via RAW_AGENT_SNAPSHOT_LOCK_WAIT_MS. */
export function snapshotLockWaitMs(): number {
  return envWaitMs() ?? DEFAULT_SNAPSHOT_LOCK_WAIT_MS;
}

export interface SnapshotLockOptions {
  staleMs?: number;
  waitMs?: number;
  now?: () => number;
  /** Test seam. Defaults to the production heartbeat. */
  startHeartbeat?: (lockPath: string) => () => void;
}

export async function withSnapshotLock<T>(dir: string, fn: () => Promise<T>, options: SnapshotLockOptions = {}): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, '.snapshot.lock');
  const held = await holdSnapshotLock(lockPath, options);
  try {
    return await fn();
  } finally {
    held.release();
  }
}

async function holdSnapshotLock(lockPath: string, options: SnapshotLockOptions): Promise<{ release: () => void }> {
  const token = `${process.pid}:${Date.now()}`;
  const fd = await acquireSnapshotLock(lockPath, token, options);
  const stopHeartbeat = (options.startHeartbeat ?? startSnapshotLockHeartbeat)(lockPath);
  return { release: () => releaseHeldSnapshotLock(lockPath, fd, token, stopHeartbeat) };
}

function releaseHeldSnapshotLock(lockPath: string, fd: number, token: string, stopHeartbeat: () => void): void {
  stopHeartbeat();
  releaseSnapshotLock(lockPath, fd, token);
}

async function acquireSnapshotLock(lockPath: string, token: string, options: SnapshotLockOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const wait = startAsyncLockWait(options.waitMs ?? snapshotLockWaitMs(), now);
  const staleMs = options.staleMs ?? SNAPSHOT_LOCK_STALE_MS;
  for (;;) {
    const fd = tryCreateSnapshotLock(lockPath, token);
    if (fd !== undefined) return fd;
    if (snapshotLockStale(lockPath, staleMs, now())) {
      reclaimStaleSnapshotLock(lockPath, staleMs, now);
      continue;
    }
    if (wait.expired()) throw new Error(`Team workspace snapshot lock timed out: ${lockPath}`);
    await wait.pause();
  }
}

function tryCreateSnapshotLock(lockPath: string, token: string): number | undefined {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, token);
    return fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
}

/**
 * Missing file is free. A live owner pid is never stale, however old the mtime.
 * Mtime staleness applies only when the pid is dead or the token has no pid.
 * A brand-new empty file is live: the holder is between create and writing its token.
 */
export function snapshotLockStale(lockPath: string, staleMs: number, now: number): boolean {
  const body = readSnapshotLockBody(lockPath);
  if (body === undefined) return true;
  if (snapshotOwnerAlive(body)) return false;
  if (body.length === 0) return snapshotLockAge(lockPath, now) > staleMs;
  return true;
}

/** A recorded live pid is never stale. Empty or unparseable content has no owner. */
function snapshotOwnerAlive(body: string): boolean {
  if (body.length === 0) return false;
  return !lockOwnerDead(body);
}

function readSnapshotLockBody(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return '';
  }
}

function snapshotLockAge(lockPath: string, now: number): number {
  try {
    return now - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Move the file we judged stale aside, then unlink only if that same inode is
 * still the dead owner. A replacement created at `lockPath` is left alone.
 */
function reclaimStaleSnapshotLock(lockPath: string, staleMs: number, now: () => number): void {
  let seen: Stats;
  try {
    seen = statSync(lockPath);
  } catch {
    return;
  }
  const parked = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.reclaim`;
  try {
    renameSync(lockPath, parked);
  } catch {
    return;
  }
  if (!sameSnapshotInode(parked, seen) || !snapshotLockStale(parked, staleMs, now())) {
    restoreParkedSnapshotLock(parked, lockPath);
    return;
  }
  try {
    unlinkSync(parked);
  } catch {
    /* another copier already removed the parked file */
  }
}

function sameSnapshotInode(path: string, seen: Stats): boolean {
  try {
    const current = statSync(path);
    return current.ino === seen.ino && current.dev === seen.dev;
  } catch {
    return false;
  }
}

function restoreParkedSnapshotLock(parked: string, lockPath: string): void {
  try {
    linkSync(parked, lockPath);
    unlinkSync(parked);
  } catch {
    /* a new owner already created lockPath; leave the parked file */
  }
}

/** Touch mtime while we hold the lock. `unref` so the timer cannot keep the process alive. */
export function startSnapshotLockHeartbeat(lockPath: string, everyMs = SNAPSHOT_LOCK_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => touchSnapshotLock(lockPath), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

function touchSnapshotLock(lockPath: string): void {
  const now = new Date();
  try {
    utimesSync(lockPath, now, now);
  } catch {
    /* released between ticks */
  }
}

function releaseSnapshotLock(lockPath: string, fd: number, token: string): void {
  closeSync(fd);
  try {
    if (readFileSync(lockPath, 'utf8') !== token) return;
    unlinkSync(lockPath);
  } catch {
    /* lock already released or replaced */
  }
}

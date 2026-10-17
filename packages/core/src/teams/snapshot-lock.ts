import { closeSync, mkdirSync, openSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLockToken,
  holdLockAcquisition,
  lockTokenNonce,
  readStaleLock,
  reclaimStaleLock,
  releaseLockAcquisition,
  releaseLockIfToken
} from './lock-liveness.js';
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

export async function withSnapshotLock<T>(dir: string, fn: () => T | Promise<T>, options: SnapshotLockOptions = {}): Promise<T> {
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
  const token = createLockToken();
  const nonce = lockTokenNonce(token);
  holdLockAcquisition(nonce);
  try {
    const fd = await acquireSnapshotLock(lockPath, token, options);
    const stopHeartbeat = (options.startHeartbeat ?? startSnapshotLockHeartbeat)(lockPath);
    return { release: () => releaseHeldSnapshotLock(lockPath, fd, token, nonce, stopHeartbeat) };
  } catch (error) {
    releaseLockAcquisition(nonce);
    throw error;
  }
}

function releaseHeldSnapshotLock(
  lockPath: string,
  fd: number,
  token: string,
  nonce: string,
  stopHeartbeat: () => void
): void {
  stopHeartbeat();
  closeSync(fd);
  releaseLockIfToken(lockPath, token);
  releaseLockAcquisition(nonce);
}

async function acquireSnapshotLock(lockPath: string, token: string, options: SnapshotLockOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const wait = startAsyncLockWait(options.waitMs ?? snapshotLockWaitMs(), now);
  const staleMs = options.staleMs ?? SNAPSHOT_LOCK_STALE_MS;
  for (;;) {
    throwIfSnapshotWaitExpired(wait, lockPath);
    const fd = tryCreateSnapshotLock(lockPath, token);
    if (fd !== undefined) return fd;
    if (reclaimIfStale(lockPath, staleMs, now)) continue;
    throwIfSnapshotWaitExpired(wait, lockPath);
    await wait.pause();
  }
}

function throwIfSnapshotWaitExpired(wait: { expired: () => boolean }, lockPath: string): void {
  if (wait.expired()) throw new Error(`Team workspace snapshot lock timed out: ${lockPath}`);
}

/** True only when a stale lock was actually removed. A failed rename is not progress. */
function reclaimIfStale(lockPath: string, staleMs: number, now: () => number): boolean {
  const stale = readStaleLock(lockPath, staleMs, now());
  if (!stale) return false;
  return reclaimStaleLock(lockPath, staleMs, now, stale);
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


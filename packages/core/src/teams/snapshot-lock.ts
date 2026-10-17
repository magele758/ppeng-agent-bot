import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFdLock } from './fd-lock.js';

/**
 * @deprecated No longer used. Locks do not expire by age; the kernel releases
 * the SQLite exclusive lock when the holder closes it or the process dies.
 */
export const SNAPSHOT_LOCK_STALE_MS = 10_000;

const DEFAULT_SNAPSHOT_LOCK_WAIT_MS = 15_000;

/**
 * @deprecated No longer used. Holders do not refresh an mtime; there is no
 * heartbeat. Kept so existing imports keep compiling.
 */
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
  /**
   * @deprecated Ignored. The lock has no time-based expiry.
   */
  staleMs?: number;
  waitMs?: number;
  now?: () => number;
  /**
   * @deprecated Ignored. There is no heartbeat to start.
   */
  startHeartbeat?: (lockPath: string) => () => void;
}

export async function withSnapshotLock<T>(dir: string, fn: () => T | Promise<T>, options: SnapshotLockOptions = {}): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, '.snapshot.lock');
  return withFdLock(join(dir, '.snapshot.lock.db'), fn, {
    waitMs: options.waitMs ?? snapshotLockWaitMs(),
    now: options.now,
    timeout: `Team workspace snapshot lock timed out: ${legacy}`
  });
}

/**
 * @deprecated No-op. Snapshot locks are kernel-owned and do not touch mtime.
 * Returns a stopper so existing callers can still clear it.
 */
export function startSnapshotLockHeartbeat(_lockPath: string, _everyMs = SNAPSHOT_LOCK_HEARTBEAT_MS): () => void {
  return () => {};
}

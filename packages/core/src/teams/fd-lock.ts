/**
 * Kernel-owned file lock.
 *
 * SQLite's EXCLUSIVE transaction is held on the database file descriptor
 * (fcntl on Unix, LockFileEx on Windows). The kernel drops it when that
 * descriptor closes, including when the holding process dies, so there is no
 * mtime, heartbeat, or pid reclaim. SQLite also excludes a second connection
 * in the same process.
 *
 * The file is `<dir>/<name>.lock.db`. Older `.mailbox.lock` / `.snapshot.lock`
 * / `inbound-dedupe.json.lock` files are a different name and are ignored.
 * This module never unlinks the database: another holder may already have it.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startAsyncLockWait, type AsyncLockWait } from './async-lock-wait.js';
import './../silence-sqlite-warning.js';

/** SQLite primary result codes. Extended codes keep these in the low byte. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export interface FdLockWait {
  waitMs: number;
  now?: () => number;
  /** Error thrown when `waitMs` elapses. A string becomes `new Error(message)`. */
  timeout: string | Error;
}

export interface HeldFdLock {
  release(): void;
}

/** True when SQLite refused because another connection holds the lock. */
export function isSqliteLockBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errcode } = error as { code?: string; errcode?: number };
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  if (typeof errcode !== 'number') return false;
  const primary = errcode & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/** Run `fn` while this process holds `dbPath`. The event loop is never busy-waited. */
export async function withFdLock<T>(dbPath: string, fn: () => T | Promise<T>, wait: FdLockWait): Promise<T> {
  const held = await acquireFdLock(dbPath, wait);
  try {
    return await fn();
  } finally {
    held.release();
  }
}

/** Open `dbPath` and take BEGIN EXCLUSIVE, retrying with async backoff until the budget ends. */
export async function acquireFdLock(dbPath: string, wait: FdLockWait): Promise<HeldFdLock> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const budget = startAsyncLockWait(wait.waitMs, wait.now ?? Date.now);
  for (;;) {
    throwIfLockWaitExpired(budget, wait.timeout);
    const held = tryBeginExclusive(dbPath);
    if (held) return held;
    throwIfLockWaitExpired(budget, wait.timeout);
    await budget.pause();
  }
}

function throwIfLockWaitExpired(budget: AsyncLockWait, timeout: string | Error): void {
  if (!budget.expired()) return;
  throw typeof timeout === 'string' ? new Error(timeout) : timeout;
}

/** undefined when another holder has the lock. Other open errors propagate. */
function tryBeginExclusive(dbPath: string): HeldFdLock | undefined {
  const db = openLockDb(dbPath);
  try {
    db.exec('BEGIN EXCLUSIVE');
    return { release: () => releaseLockDb(db) };
  } catch (error) {
    closeQuiet(db);
    if (isSqliteLockBusy(error)) return undefined;
    throw error;
  }
}

function openLockDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=0');
  return db;
}

function releaseLockDb(db: DatabaseSync): void {
  if (!db.isOpen) return;
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } finally {
    closeQuiet(db);
  }
}

function closeQuiet(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

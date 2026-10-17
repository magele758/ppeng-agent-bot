import { randomUUID } from 'node:crypto';
import type { SqliteStateStore } from '../storage.js';

const PROCESS_OWNER = randomUUID();
export const ROUTINE_LEASE_MS = 60_000;
function isTransientLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errcode } = error as { code?: string; errcode?: number };
  // node:sqlite uses ERR_SQLITE_ERROR with SQLite's numeric (possibly extended) code.
  return (typeof errcode === 'number' && [5, 6].includes(errcode & 0xff))
    || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}
export function ensureRoutineLeaseSchema(store: Pick<SqliteStateStore, 'db'>): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS bot_routine_leases (
    run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`);
}

/** A per-acquisition fencing token also excludes overlapping drains in one process. */
export class RoutineLease {
  private constructor(
    private store: Pick<SqliteStateStore, 'db'>,
    readonly runId: string,
    private token: string,
    private duration: number
  ) {}

  static acquire(store: Pick<SqliteStateStore, 'db'>, runId: string, now = Date.now(), duration = ROUTINE_LEASE_MS): RoutineLease | undefined {
    const ownTransaction = !store.db.isTransaction;
    if (ownTransaction) store.db.exec('BEGIN IMMEDIATE');
    try {
      const token = randomUUID();
      const result = store.db.prepare(`INSERT INTO bot_routine_leases(run_id,owner_id,token,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET owner_id=excluded.owner_id,token=excluded.token,expires_at=excluded.expires_at
        WHERE bot_routine_leases.expires_at<=?`).run(runId, PROCESS_OWNER, token, now + duration, now);
      if (ownTransaction) store.db.exec('COMMIT');
      return result.changes ? new RoutineLease(store, runId, token, duration) : undefined;
    } catch (error) {
      if (ownTransaction) store.db.exec('ROLLBACK');
      throw error;
    }
  }

  owns(now = Date.now()): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM bot_routine_leases WHERE run_id=? AND token=? AND expires_at>?').get(this.runId, this.token, now);
  }

  renew(now = Date.now()): boolean {
    // Expiry permits takeover; only a replaced/deleted token proves ownership lost.
    // A delayed heartbeat can renew atomically unless another owner got here first.
    return !!this.store.db.prepare('UPDATE bot_routine_leases SET expires_at=? WHERE run_id=? AND token=?')
      .run(now + this.duration, this.runId, this.token).changes;
  }

  /** True when another owner (different token) holds an unexpired lease — cross-instance liveness signal. */
  static hasOtherActiveLease(store: Pick<SqliteStateStore, 'db'>, runId: string, ownToken: string, now = Date.now()): boolean {
    return !!store.db.prepare('SELECT 1 FROM bot_routine_leases WHERE run_id=? AND token<>? AND expires_at>?').get(runId, ownToken, now);
  }

  /** True when a peer (not this lease) holds an unexpired lease for the same run. */
  hasOtherActive(now = Date.now()): boolean {
    return RoutineLease.hasOtherActiveLease(this.store, this.runId, this.token, now);
  }

  /** Fence state changes in the same write transaction as the ownership check. */
  whileOwned<T>(action: () => T): T | undefined {
    const ownTransaction = !this.store.db.isTransaction;
    if (ownTransaction) this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.renew() ? action() : undefined;
      if (ownTransaction) this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownTransaction) this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  release(): void {
    this.store.db.prepare('DELETE FROM bot_routine_leases WHERE run_id=? AND token=?').run(this.runId, this.token);
  }

  heartbeat(onLost: () => void): () => void {
    const timer = setInterval(() => {
      try { if (this.renew()) return; } catch (error) {
        // Contention is not evidence of takeover. Keep retrying; completion still
        // renews and fences against the token under the same write transaction.
        if (isTransientLockError(error)) return;
      }
      clearInterval(timer);
      onLost();
    }, Math.floor(this.duration / 3));
    timer.unref();
    return () => clearInterval(timer);
  }
}

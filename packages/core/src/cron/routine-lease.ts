import { randomUUID } from 'node:crypto';
import type { SqliteStateStore } from '../storage.js';

const PROCESS_OWNER = randomUUID();
export const ROUTINE_LEASE_MS = 60_000;
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
    const ownTransaction = !store.db.inTransaction;
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
    return !!this.store.db.prepare('UPDATE bot_routine_leases SET expires_at=? WHERE run_id=? AND token=? AND expires_at>?')
      .run(now + this.duration, this.runId, this.token, now).changes;
  }

  /** Fence state changes in the same write transaction as the ownership check. */
  whileOwned<T>(action: () => T): T | undefined {
    const ownTransaction = !this.store.db.inTransaction;
    if (ownTransaction) this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.owns() ? action() : undefined;
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
      try { if (this.renew()) return; } catch { /* An unrenewable lease must not authorize completion. */ }
      clearInterval(timer);
      onLost();
    }, Math.floor(this.duration / 3));
    timer.unref();
    return () => clearInterval(timer);
  }
}

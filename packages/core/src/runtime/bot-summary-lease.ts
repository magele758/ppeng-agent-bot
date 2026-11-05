import { randomUUID } from 'node:crypto';
import type { SqliteStateStore } from '../storage.js';

const key = (id: string) => `bot.summaryLease:${id}`;

/** SQLite arbitration also covers two runtimes connected to the same state. */
export function claimSummaryLease(store: SqliteStateStore, id: string): string | undefined {
  const owner = randomUUID();
  const now = Date.now();
  const value = JSON.stringify({ owner, until: now + 75_000 });
  const result = store.db.prepare(`INSERT INTO daemon_control(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
    WHERE json_extract(daemon_control.value_json,'$.until') <= ?`)
    .run(key(id), value, new Date(now).toISOString(), now);
  return result.changes ? owner : undefined;
}

export function summaryLeaseCurrent(store: SqliteStateStore, id: string, owner: string): boolean {
  const lease = store.getDaemonControl<{ owner: string; until: number }>(key(id));
  return lease?.owner === owner && lease.until > Date.now();
}

export function releaseSummaryLease(store: SqliteStateStore, id: string, owner: string): void {
  store.db.prepare("DELETE FROM daemon_control WHERE key=? AND json_extract(value_json,'$.owner')=?").run(key(id), owner);
}

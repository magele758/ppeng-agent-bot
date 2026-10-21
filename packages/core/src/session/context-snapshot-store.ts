import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createId, nowIso } from '../id.js';
import {
  contextSnapshotFingerprint,
  orderContextSnapshots,
  parseContextSnapshotBlocks,
  type ContextSnapshot,
  type ContextSnapshotBlock
} from './context-snapshots.js';

/** Snapshots kept per session; RAW_AGENT_CONTEXT_SNAPSHOT_LIMIT (1-10000, read at startup) overrides. */
const CONTEXT_SNAPSHOT_LIMIT = (() => {
  const v = Number(process.env['RAW_AGENT_CONTEXT_SNAPSHOT_LIMIT']);
  return Number.isFinite(v) && v >= 1 && v <= 10_000 ? Math.floor(v) : 50;
})();

export function contextSnapshotRetentionLimit(): number {
  return CONTEXT_SNAPSHOT_LIMIT;
}

/** Sessions whose latest-row fingerprint digest stays in memory (LRU). */
const FINGERPRINT_CACHE_LIMIT = 512;

interface SnapshotHead {
  id: string;
  session_id: string;
  turn_index: number;
  created_at: string;
}

interface SnapshotRow extends SnapshotHead {
  blocks_json: string;
}

function toSnapshot(row: SnapshotRow): ContextSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    turn: row.turn_index,
    createdAt: row.created_at,
    blocks: parseContextSnapshotBlocks(row.blocks_json)
  };
}

function fingerprintDigest(blocks: readonly ContextSnapshotBlock[]): string {
  return createHash('sha1').update(contextSnapshotFingerprint(blocks)).digest('hex');
}

export class ContextSnapshotStore {
  /**
   * Latest row id -> fingerprint digest. Dedupe runs on every prepared model
   * request; without this it re-read, re-parsed and re-fingerprinted the whole
   * stored latest snapshot each time, on the daemon event loop.
   */
  private readonly latest = new Map<string, { id: string; digest: string }>();

  constructor(private readonly db: DatabaseSync) {}

  private remember(sessionId: string, id: string, digest: string): void {
    this.latest.delete(sessionId);
    this.latest.set(sessionId, { id, digest });
    if (this.latest.size > FINGERPRINT_CACHE_LIMIT) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
  }

  private blocksJson(id: string): string {
    const row = this.db.prepare('SELECT blocks_json FROM context_stack_snapshots WHERE id = ?').get(id) as
      | { blocks_json: string }
      | undefined;
    return row?.blocks_json ?? '[]';
  }

  private latestDigest(head: SnapshotHead): string {
    const cached = this.latest.get(head.session_id);
    if (cached && cached.id === head.id) return cached.digest;
    const digest = fingerprintDigest(parseContextSnapshotBlocks(this.blocksJson(head.id)));
    this.remember(head.session_id, head.id, digest);
    return digest;
  }

  append(sessionId: string, blocks: readonly ContextSnapshotBlock[]): { snapshot: ContextSnapshot; created: boolean } {
    const digest = fingerprintDigest(blocks);
    const sp = `ctxsnap_${sessionId.replace(/[^a-z0-9]/gi, '_')}`;
    this.db.exec(`SAVEPOINT "${sp}"`);
    try {
      const latest = this.db
        .prepare(
          `SELECT id, session_id, turn_index, created_at
           FROM context_stack_snapshots
           WHERE session_id = ?
           ORDER BY turn_index DESC, created_at DESC, id DESC
           LIMIT 1`
        )
        .get(sessionId) as SnapshotHead | undefined;
      if (latest && this.latestDigest(latest) === digest) {
        this.db.exec(`RELEASE "${sp}"`);
        const store = this;
        // Stored blocks are only parsed if a caller reads them; the prepare path never does.
        let parsed: ContextSnapshotBlock[] | undefined;
        const snapshot = {
          id: latest.id,
          sessionId: latest.session_id,
          turn: latest.turn_index,
          createdAt: latest.created_at,
          get blocks(): ContextSnapshotBlock[] {
            parsed ??= parseContextSnapshotBlocks(store.blocksJson(latest.id));
            return parsed;
          }
        } as ContextSnapshot;
        return { snapshot, created: false };
      }
      const row: SnapshotRow = {
        id: createId('ctxsnap'),
        session_id: sessionId,
        turn_index: (latest?.turn_index ?? 0) + 1,
        created_at: nowIso(),
        blocks_json: JSON.stringify(blocks)
      };
      this.db
        .prepare(
          `INSERT INTO context_stack_snapshots (id, session_id, turn_index, created_at, blocks_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(row.id, row.session_id, row.turn_index, row.created_at, row.blocks_json);
      // Prune oldest rows beyond CONTEXT_SNAPSHOT_LIMIT within the same transaction
      this.db
        .prepare(
          `DELETE FROM context_stack_snapshots
           WHERE session_id = ?
             AND id NOT IN (
               SELECT id FROM context_stack_snapshots
               WHERE session_id = ?
               ORDER BY turn_index DESC, created_at DESC, id DESC
               LIMIT ?
             )`
        )
        .run(sessionId, sessionId, CONTEXT_SNAPSHOT_LIMIT);
      this.db.exec(`RELEASE "${sp}"`);
      this.remember(sessionId, row.id, digest);
      return { snapshot: toSnapshot(row), created: true };
    } catch (error) {
      this.db.exec(`ROLLBACK TO "${sp}"`);
      this.db.exec(`RELEASE "${sp}"`);
      throw error;
    }
  }

  list(sessionId: string): ContextSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, turn_index, created_at, blocks_json
         FROM context_stack_snapshots
         WHERE session_id = ?
         ORDER BY turn_index ASC, created_at ASC, id ASC`
      )
      .all(sessionId) as unknown as SnapshotRow[];
    return orderContextSnapshots(rows.map(toSnapshot));
  }
}

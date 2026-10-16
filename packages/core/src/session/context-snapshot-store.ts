import type { DatabaseSync } from 'node:sqlite';
import { createId, nowIso } from '../id.js';
import {
  contextSnapshotFingerprint,
  orderContextSnapshots,
  parseContextSnapshotBlocks,
  type ContextSnapshot,
  type ContextSnapshotBlock
} from './context-snapshots.js';

interface SnapshotRow {
  id: string;
  session_id: string;
  turn_index: number;
  created_at: string;
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

export class ContextSnapshotStore {
  constructor(private readonly db: DatabaseSync) {}

  append(sessionId: string, blocks: readonly ContextSnapshotBlock[]): { snapshot: ContextSnapshot; created: boolean } {
    const fingerprint = contextSnapshotFingerprint(blocks);
    const blocksJson = JSON.stringify(blocks);
    this.db.exec('BEGIN');
    try {
      const latest = this.db
        .prepare(
          `SELECT id, session_id, turn_index, created_at, blocks_json
           FROM context_stack_snapshots
           WHERE session_id = ?
           ORDER BY turn_index DESC, created_at DESC, id DESC
           LIMIT 1`
        )
        .get(sessionId) as SnapshotRow | undefined;
      if (latest && contextSnapshotFingerprint(parseContextSnapshotBlocks(latest.blocks_json)) === fingerprint) {
        this.db.exec('COMMIT');
        return { snapshot: toSnapshot(latest), created: false };
      }
      const row: SnapshotRow = {
        id: createId('ctxsnap'),
        session_id: sessionId,
        turn_index: (latest?.turn_index ?? 0) + 1,
        created_at: nowIso(),
        blocks_json: blocksJson
      };
      this.db
        .prepare(
          `INSERT INTO context_stack_snapshots (id, session_id, turn_index, created_at, blocks_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(row.id, row.session_id, row.turn_index, row.created_at, row.blocks_json);
      this.db.exec('COMMIT');
      return { snapshot: toSnapshot(row), created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
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

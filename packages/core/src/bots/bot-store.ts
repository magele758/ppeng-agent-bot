import type { DatabaseSync } from 'node:sqlite';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../id.js';
import { boolToInt, intToBool } from '../stores/storage-helpers.js';
import { readBotFaceColor, readBotFaceShape } from './bot-appearance.js';
import type { BotRecord, ListBotsOptions, UpdateBotInput } from './types.js';

export class BotStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(bot: BotRecord): BotRecord {
    this.db
      .prepare(
        `
        INSERT INTO bots (
          id, name, title, description, agent_id, canonical_session_id,
          hidden, face_shape, face_color, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        bot.id,
        bot.name,
        bot.title,
        bot.description,
        bot.agentId,
        bot.canonicalSessionId,
        boolToInt(bot.hidden),
        bot.faceShape ?? null,
        bot.faceColor ?? null,
        bot.createdAt,
        bot.updatedAt
      );
    return bot;
  }

  get(id: string): BotRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getByName(name: string): BotRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM bots WHERE lower(name) = lower(?)`).get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  getByCanonicalSessionId(sessionId: string): BotRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM bots WHERE canonical_session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(opts?: ListBotsOptions): BotRecord[] {
    const sql = opts?.includeHidden
      ? `SELECT * FROM bots ORDER BY hidden ASC, name COLLATE NOCASE ASC`
      : `SELECT * FROM bots WHERE hidden = 0 ORDER BY name COLLATE NOCASE ASC`;
    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  count(opts?: ListBotsOptions): number {
    const sql = opts?.includeHidden
      ? `SELECT COUNT(*) AS n FROM bots`
      : `SELECT COUNT(*) AS n FROM bots WHERE hidden = 0`;
    const row = this.db.prepare(sql).get() as { n: number };
    return Number(row.n);
  }

  update(id: string, patch: UpdateBotInput & { canonicalSessionId?: string }): BotRecord {
    const current = this.get(id);
    if (!current) throw new NotFoundError('Bot', id);
    const next: BotRecord = {
      ...current,
      name: patch.name !== undefined ? patch.name : current.name,
      title: patch.title !== undefined ? patch.title : current.title,
      description: patch.description !== undefined ? patch.description : current.description,
      hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
      faceShape: patch.faceShape !== undefined ? readBotFaceShape(patch.faceShape) : current.faceShape,
      faceColor: patch.faceColor !== undefined ? readBotFaceColor(patch.faceColor) : current.faceColor,
      canonicalSessionId: patch.canonicalSessionId ?? current.canonicalSessionId,
      updatedAt: nowIso()
    };
    this.db
      .prepare(
        `
        UPDATE bots SET
          name = ?, title = ?, description = ?, canonical_session_id = ?,
          hidden = ?, face_shape = ?, face_color = ?, updated_at = ?
        WHERE id = ?
      `
      )
      .run(
        next.name,
        next.title,
        next.description,
        next.canonicalSessionId,
        boolToInt(next.hidden),
        next.faceShape,
        next.faceColor,
        next.updatedAt,
        id
      );
    return next;
  }

  private mapRow(row: Record<string, unknown>): BotRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      title: String(row.title ?? ''),
      description: String(row.description ?? ''),
      agentId: String(row.agent_id),
      canonicalSessionId: String(row.canonical_session_id),
      hidden: intToBool(row.hidden),
      faceShape: readBotFaceShape(row.face_shape),
      faceColor: readBotFaceColor(row.face_color),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}

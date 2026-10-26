import type { DatabaseSync } from 'node:sqlite';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../id.js';
import { boolToInt, intToBool } from '../stores/storage-helpers.js';
import {
  normalizeBotAvatar,
  normalizeFaceColorForStyle,
  normalizeFaceShapeForStyle,
  readBotFaceColor,
  readBotFaceShape,
  normalizeBotFaceStyle,
  normalizeFaceExpressionForStyle,
  readBotFaceExpression,
  readBotFaceStyle
} from './bot-appearance.js';
import type { BotRecord, ListBotsOptions, UpdateBotInput } from './types.js';

export class BotStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(bot: BotRecord): BotRecord {
    this.db
      .prepare(
        `
        INSERT INTO bots (
          id, name, title, description, agent_id, canonical_session_id,
          hidden, face_shape, face_color, face_style, face_expression, avatar, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        bot.faceStyle ?? null,
        bot.faceExpression ?? null,
        bot.avatar ?? null,
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
    const faceStyle = patch.faceStyle !== undefined ? normalizeBotFaceStyle(patch.faceStyle) : current.faceStyle;
    const styleChanged = patch.faceStyle !== undefined && (faceStyle === 'soft') !== (current.faceStyle === 'soft');
    const next: BotRecord = {
      ...current,
      name: patch.name !== undefined ? patch.name : current.name,
      title: patch.title !== undefined ? patch.title : current.title,
      description: patch.description !== undefined ? patch.description : current.description,
      hidden: patch.hidden !== undefined ? patch.hidden : current.hidden,
      faceShape:
        patch.faceShape !== undefined || styleChanged
          ? normalizeFaceShapeForStyle(styleChanged && patch.faceShape === undefined ? null : patch.faceShape, faceStyle)
          : current.faceShape,
      faceColor:
        patch.faceColor !== undefined || styleChanged
          ? normalizeFaceColorForStyle(styleChanged && patch.faceColor === undefined ? null : patch.faceColor, faceStyle)
          : current.faceColor,
      faceStyle,
      faceExpression:
        patch.faceExpression !== undefined || (styleChanged && faceStyle !== 'soft')
          ? normalizeFaceExpressionForStyle(styleChanged && faceStyle !== 'soft' ? null : patch.faceExpression, faceStyle)
          : current.faceExpression,
      avatar: patch.avatar !== undefined ? normalizeBotAvatar(patch.avatar) : current.avatar,
      canonicalSessionId: patch.canonicalSessionId ?? current.canonicalSessionId,
      updatedAt: nowIso()
    };
    this.db
      .prepare(
        `
        UPDATE bots SET
          name = ?, title = ?, description = ?, canonical_session_id = ?,
          hidden = ?, face_shape = ?, face_color = ?, face_style = ?, face_expression = ?, avatar = ?, updated_at = ?
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
        next.faceStyle,
        next.faceExpression,
        next.avatar,
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
      faceStyle: readBotFaceStyle(row.face_style),
      faceExpression: readBotFaceExpression(row.face_expression),
      avatar: row.avatar == null || row.avatar === '' ? null : String(row.avatar),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}

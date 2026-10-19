import type { TextPart } from '@ppeng/api-types';
import { DatabaseSync } from 'node:sqlite';
import { createId, nowIso } from '../id.js';
import { applyInboxOverflow, resolveInboxOverflowCap } from './inbox-overflow.js';
import type { SteerInterruptPolicy } from './steer-interrupt.js';

export type InboxTarget = 'next-step' | 'next-run';
export type InboxRole = 'user' | 'system';

export interface InboxItem {
  id: string;
  sessionId: string;
  target: InboxTarget;
  role: InboxRole;
  text: string;
  contextParts?: TextPart[];
  key?: string;
  createdAt: string;
  claimedAt?: string;
}

export type SteerMode = 'prompt' | 'subagent';

export interface EnqueueSteerOptions {
  /** Trusted host-prepared attachment text and display metadata; preserved through edits/drain. */
  contextParts?: TextPart[];
  target?: InboxTarget;
  key?: string;
  role?: InboxRole;
  /** prompt = inbox only (default). subagent = spawn parallel child. */
  steerMode?: SteerMode;
  subagentRole?: string;
  /** Running-turn policy; admission reads KV if omitted. */
  interruptPolicy?: SteerInterruptPolicy;
}

/**
 * Step inbox: user steer that lands on the *next* model shot, never mutating
 * an in-flight HTTP request. Same `key` overwrites — only the latest unclaimed
 * item with that key is claimed. Optional Lab `inboxOverflowCap` (default off)
 * folds oldest unclaimed items into one system summary when over the cap.
 */
export class StepInboxStore {
  private contextColumnReady = false;
  constructor(private readonly db: DatabaseSync) {}

  private ensureContextColumn(): void {
    if (this.contextColumnReady) return;
    const hasColumn = () => (this.db.prepare('PRAGMA table_info(session_inbox)').all() as Array<{ name: string }>).some(column => column.name === 'context_parts_json');
    if (!hasColumn()) {
      try { this.db.exec('ALTER TABLE session_inbox ADD COLUMN context_parts_json TEXT'); }
      catch (error) { if (!hasColumn()) throw error; }
    }
    this.contextColumnReady = true;
  }

  enqueue(sessionId: string, text: string, opts: EnqueueSteerOptions = {}): InboxItem {
    const item = this.insert(sessionId, text, opts);
    const cap = resolveInboxOverflowCap({ store: this.controlStore() });
    applyInboxOverflow(
      {
        listUnclaimed: (id) => this.listUnclaimed(id),
        markClaimed: (ids) => this.markClaimed(ids),
        enqueueSummary: (id, summary, summaryOpts) => this.insert(id, summary, summaryOpts)
      },
      sessionId,
      cap
    );
    return item;
  }

  markClaimed(ids: string[]): void {
    if (ids.length === 0) return;
    const claimedAt = nowIso();
    const mark = this.db.prepare(`UPDATE session_inbox SET claimed_at = ? WHERE id = ?`);
    for (const id of ids) mark.run(claimedAt, id);
  }

  /**
   * Claim unclaimed items for `target`. Same-key items: only the latest
   * (created_at, id) is returned; older unclaimed siblings are marked claimed
   * without being applied.
   */
  claim(sessionId: string, target: InboxTarget): InboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_inbox
         WHERE session_id = ? AND target = ? AND claimed_at IS NULL
         ORDER BY rowid ASC`
      )
      .all(sessionId, target) as Array<Record<string, unknown>>;

    const items = rows.map(mapInboxRow);
    const latestByKey = new Map<string, InboxItem>();
    const keyedSkipped: InboxItem[] = [];
    const unkeyed: InboxItem[] = [];
    for (const item of items) {
      if (!item.key) {
        unkeyed.push(item);
        continue;
      }
      const prev = latestByKey.get(item.key);
      if (prev) keyedSkipped.push(prev);
      latestByKey.set(item.key, item);
    }

    const claimedAt = nowIso();
    const apply = [...unkeyed, ...latestByKey.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
    const mark = this.db.prepare(`UPDATE session_inbox SET claimed_at = ? WHERE id = ?`);
    for (const item of [...apply, ...keyedSkipped]) {
      mark.run(claimedAt, item.id);
      item.claimedAt = claimedAt;
    }
    return apply;
  }

  listUnclaimed(sessionId: string): InboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_inbox
         WHERE session_id = ? AND claimed_at IS NULL
         ORDER BY rowid ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(mapInboxRow);
  }

  getUnclaimed(sessionId: string, itemId: string): InboxItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM session_inbox
         WHERE id = ? AND session_id = ? AND claimed_at IS NULL`
      )
      .get(itemId, sessionId) as Record<string, unknown> | undefined;
    return row ? mapInboxRow(row) : undefined;
  }

  updateUnclaimed(sessionId: string, itemId: string, text: string): InboxItem | undefined {
    const next = text.trim();
    if (!next) return undefined;
    const item = this.getUnclaimed(sessionId, itemId);
    if (!item) return undefined;
    this.db
      .prepare(`UPDATE session_inbox SET text = ? WHERE id = ? AND session_id = ? AND claimed_at IS NULL`)
      .run(next, itemId, sessionId);
    return { ...item, text: next };
  }

  /** Drop an unclaimed item so it will not drain. */
  removeUnclaimed(sessionId: string, itemId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM session_inbox WHERE id = ? AND session_id = ? AND claimed_at IS NULL`)
      .run(itemId, sessionId);
    return Number(result.changes ?? 0) > 0;
  }

  private insert(sessionId: string, text: string, opts: EnqueueSteerOptions = {}): InboxItem {
    this.ensureContextColumn();
    const item: InboxItem = {
      id: createId('steer'),
      sessionId,
      target: opts.target ?? 'next-step',
      role: opts.role ?? 'user',
      text,
      contextParts: opts.contextParts,
      key: opts.key,
      createdAt: nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO session_inbox (id, session_id, target, role, text, key, created_at, context_parts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.sessionId,
        item.target,
        item.role,
        item.text,
        item.key ?? null,
        item.createdAt,
        item.contextParts?.length ? JSON.stringify(item.contextParts) : null
      );
    return item;
  }

  /** Best-effort read of daemon_control KV (missing table → unlimited cap). */
  private controlStore(): { getDaemonControl(key: string): unknown } {
    return {
      getDaemonControl: (key: string) => {
        try {
          const row = this.db
            .prepare(`SELECT value_json FROM daemon_control WHERE key = ?`)
            .get(key) as { value_json: string } | undefined;
          if (!row?.value_json) return undefined;
          return JSON.parse(row.value_json) as unknown;
        } catch {
          return undefined;
        }
      }
    };
  }
}

function mapInboxRow(row: Record<string, unknown>): InboxItem {
  const key = row.key == null || row.key === '' ? undefined : String(row.key);
  const claimedAt = row.claimed_at == null ? undefined : String(row.claimed_at);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    target: row.target === 'next-run' ? 'next-run' : 'next-step',
    role: row.role === 'system' ? 'system' : 'user',
    contextParts: row.context_parts_json ? JSON.parse(String(row.context_parts_json)) as TextPart[] : undefined,
    text: String(row.text),
    key,
    createdAt: String(row.created_at),
    claimedAt
  };
}

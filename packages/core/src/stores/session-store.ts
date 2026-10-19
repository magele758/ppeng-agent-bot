import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tryAcquireFdLock, type HeldFdLock } from '../teams/fd-lock.js';
import type { HistoryOptions, HistoryPage, HistoryContext } from '../session/history/types.js';
import { DatabaseSync } from 'node:sqlite';
import { captureTaskContext, taskContextTodos } from '../session/task-context.js';
import { createId, nowIso } from '../id.js';
import { serializeJson, parseJson, optionalString, boolToInt, intToBool } from './storage-helpers.js';
import { ValidationError } from '../errors.js';
import { normalizeReplyQuote, replyToFromColumn } from '../session/reply-quote.js';
import type { MessageReplyTo, MessageRole, SessionMessage, SessionRecord, SessionStatus } from '../types.js';
import {
  assertNoOpenToolWaveForCompact,
  assertReplaceRangeClosed,
  assertReplaceRangeCovered,
  assertSeqStrictlyIncreasing,
  foldSurface,
  parseSurfaceOp,
  type SurfaceNode,
  type SurfaceOp
} from '../session/surface-invariants.js';
import { assertWriterClaim, WriterClaimError } from '../session/writer-claim.js';
import type { SurfaceWriteOpts } from '../session/surface-store.js';

export interface CreateSessionInput {
  title: string;
  mode: SessionRecord['mode'];
  agentId: string;
  taskId?: string;
  workspaceId?: string;
  parentSessionId?: string;
  background?: boolean;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendReplacementInput {
  startSeq: number;
  endSeq: number;
  role: MessageRole;
  parts: SessionMessage['parts'];
  key?: string;
  expectedWriterRunId?: string;
}

function historyRole(value: string | undefined): MessageRole | undefined {
  if (value === undefined || value === '') return undefined;
  switch (value) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'tool':
      return value;
    default:
      throw new Error('Invalid history role');
  }
}

/**
 * Domain store for session + message persistence.
 * Shares the same DatabaseSync instance with SqliteStateStore.
 *
 * `session_messages` is an append-only WAL. Visibility is a surface algebra
 * (append / replace / hide). The model path must use {@link foldMessages},
 * never {@link listMessages}.
 */
export class SessionStore {
  private readonly writerBindings = new Map<string, string>();
  private historyFts: boolean | undefined;

  private readonly writerScope = new AsyncLocalStorage<{ sessionId: string; runId: string }>();
  private readonly writerLocks = new Map<string, { runId: string; held: HeldFdLock }>();
  constructor(private readonly db: DatabaseSync, private readonly dbPath?: string) {}

  getLocalWriterId(sessionId: string): string | undefined { return this.writerBindings.get(sessionId); }

  runWithWriter<T>(sessionId: string, runId: string, fn: () => Promise<T>): Promise<T> {
    return this.writerScope.run({ sessionId, runId }, fn);
  }

  /** Control-plane operations must validate current persisted state, not inherit a finished turn. */
  runWithoutWriterScope<T>(fn: () => T): T { return this.writerScope.exit(fn); }

  isWriterCurrent(sessionId: string, runId: string): boolean {
    return this.getSession(sessionId)?.activeWriterRunId === runId;
  }

  assertCurrentWriter(sessionId: string): void {
    const scope = this.writerScope.getStore();
    if (scope?.sessionId === sessionId && !this.isWriterCurrent(sessionId, scope.runId)) {
      throw new WriterClaimError(sessionId, scope.runId, this.getSession(sessionId)?.activeWriterRunId);
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private writerPath(sessionId: string, runId: string): string | undefined {
    if (!this.dbPath || this.dbPath === ':memory:') return undefined;
    const key = createHash('sha256').update(sessionId + '\0' + runId).digest('hex');
    return join(dirname(this.dbPath), 'writer-locks', key + '.lock.db');
  }

  isSessionWriterLive(sessionId: string): boolean {
    const runId = this.getSession(sessionId)?.activeWriterRunId;
    if (!runId) return false;
    if (this.writerLocks.get(sessionId)?.runId === runId) return true;
    const path = this.writerPath(sessionId, runId);
    if (!path) return true;
    const probe = tryAcquireFdLock(path);
    if (!probe) return true;
    probe.release(); return false;
  }

  releaseWriterLocks(): void {
    for (const { held } of this.writerLocks.values()) held.release();
    this.writerLocks.clear();
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const now = nowIso();
    const session: SessionRecord = {
      id: createId('session'),
      title: input.title,
      mode: input.mode,
      status: 'idle',
      agentId: input.agentId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      background: input.background ?? false,
      summary: input.summary,
      todo: [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(`
        INSERT INTO sessions (
          id, title, mode, status, agent_id, task_id, workspace_id, parent_session_id, background,
          summary, todo_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.title,
        session.mode,
        session.status,
        session.agentId,
        session.taskId ?? null,
        session.workspaceId ?? null,
        session.parentSessionId ?? null,
        boolToInt(session.background),
        session.summary ?? null,
        serializeJson(session.todo),
        serializeJson(session.metadata),
        session.createdAt,
        session.updatedAt
      );

    return session;
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapSessionRow(row));
  }

  listIdleBackgroundSessions(modes: readonly string[]): SessionRecord[] {
    if (modes.length === 0) return [];
    const placeholders = modes.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE background = 1 AND status = 'idle' AND mode IN (${placeholders}) ORDER BY updated_at DESC`
      )
      .all(...modes) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapSessionRow(row));
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSessionRow(row) : undefined;
  }

  updateSession(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>
  ): SessionRecord {
    return this.transaction(() => {
    this.assertCurrentWriter(sessionId);
    const existing = this.getSession(sessionId);
    if (!existing) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const next: SessionRecord = {
      ...existing,
      ...patch,
      updatedAt: nowIso()
    };

    this.db
      .prepare(`
        UPDATE sessions
        SET title = ?, mode = ?, status = ?, agent_id = ?, task_id = ?, workspace_id = ?,
            parent_session_id = ?, background = ?, summary = ?, todo_json = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.mode,
        next.status,
        next.agentId,
        next.taskId ?? null,
        next.workspaceId ?? null,
        next.parentSessionId ?? null,
        boolToInt(next.background),
        next.summary ?? null,
        serializeJson(next.todo),
        serializeJson(next.metadata),
        next.updatedAt,
        next.id
      );

    return next;
    });
  }

  /**
   * Remove a session row and its session-scoped children. Optional FK tables
   * are skipped if they do not exist yet (older test DBs).
   */
  deleteSession(sessionId: string): boolean {
    if (!this.getSession(sessionId)) return false;
    const run = (sql: string, id: string) => {
      try {
        this.db.prepare(sql).run(id);
      } catch {
        /* table / column may be absent */
      }
    };
    this.db.exec('BEGIN');
    try {
      for (const table of [
        'session_messages',
        'session_inbox',
        'session_memory',
        'approvals',
        'background_jobs',
        'image_assets',
        'scheduler_wake',
        'attachments',
        'artifacts',
        'goal_records',
        'agent_cases',
        'context_stack_snapshots'
      ]) {
        run(`DELETE FROM ${table} WHERE session_id = ?`, sessionId);
      }
      run('DELETE FROM mailbox WHERE session_id = ?', sessionId);
      run('UPDATE tasks SET session_id = NULL WHERE session_id = ?', sessionId);
      run('UPDATE self_heal_runs SET session_id = NULL WHERE session_id = ?', sessionId);
      run('UPDATE team_plans SET session_id = NULL WHERE session_id = ?', sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return true;
  }

  claimWriter(sessionId: string, runId: string): void {
    const existing = this.getSession(sessionId);
    if (!existing) throw new Error(`Session ${sessionId} not found`);
    if (this.writerLocks.get(sessionId)?.runId === runId && existing.activeWriterRunId === runId) return;
    const path = this.writerPath(sessionId, runId);
    const held = path ? tryAcquireFdLock(path) : undefined;
    if (path && !held) throw new WriterClaimError(sessionId, runId, existing.activeWriterRunId);
    try {
      if (existing.activeWriterRunId && this.isSessionWriterLive(sessionId)) {
        throw new WriterClaimError(sessionId, runId, existing.activeWriterRunId);
      }
      const result = this.db.prepare(
        'UPDATE sessions SET active_writer_run_id = ?, updated_at = ? WHERE id = ? AND active_writer_run_id IS ?'
      ).run(runId, nowIso(), sessionId, existing.activeWriterRunId ?? null);
      if (!Number(result.changes)) throw new WriterClaimError(sessionId, runId, this.getSession(sessionId)?.activeWriterRunId);
      // A revoked older context may still be unwinding. Its handle is no longer authoritative.
      this.writerLocks.get(sessionId)?.held.release();
      if (held) this.writerLocks.set(sessionId, { runId, held });
      this.writerBindings.set(sessionId, runId);
    } catch (error) { held?.release(); throw error; }
  }

  releaseWriter(sessionId: string, runId: string): void {
    const existing = this.getSession(sessionId);
    if (existing?.activeWriterRunId === runId) {
      this.db.prepare('UPDATE sessions SET active_writer_run_id = NULL, updated_at = ? WHERE id = ? AND active_writer_run_id = ?')
        .run(nowIso(), sessionId, runId);
    }
    const lock = this.writerLocks.get(sessionId);
    if (lock?.runId === runId) { lock.held.release(); this.writerLocks.delete(sessionId); }
    if (this.writerBindings.get(sessionId) === runId) this.writerBindings.delete(sessionId);
  }

  /**
   * Drop selected parts from one append row. An empty remainder deletes the row.
   * The history index has an insert and a delete trigger but no update trigger,
   * so a rewrite deletes and reinserts the FTS row for the same message id.
   */
  rewriteMessageParts(sessionId: string, messageId: string, parts: SessionMessage['parts']): boolean {
    const row = this.db
      .prepare(`SELECT id FROM session_messages WHERE id = ? AND session_id = ? AND (surface_op IS NULL OR surface_op = 'append')`)
      .get(messageId, sessionId) as { id: string } | undefined;
    if (!row) return false;
    if (parts.length === 0) {
      this.db.prepare(`DELETE FROM session_messages WHERE id = ? AND session_id = ?`).run(messageId, sessionId);
    } else {
      const json = serializeJson(parts);
      this.db.prepare(`UPDATE session_messages SET parts_json = ? WHERE id = ? AND session_id = ?`).run(json, messageId, sessionId);
      this.syncHistoryIndex(messageId, sessionId, json);
    }
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(nowIso(), sessionId);
    return true;
  }

  /** Keep session_history_fts aligned with a rewritten parts payload. Missing index is fine. */
  private syncHistoryIndex(messageId: string, sessionId: string, partsJson: string): void {
    try {
      this.db.prepare(`DELETE FROM session_history_fts WHERE message_id = ?`).run(messageId);
      this.db.prepare(`INSERT INTO session_history_fts(message_id, session_id, text) VALUES(?, ?, ?)`).run(messageId, sessionId, partsJson);
    } catch (error) {
      const message = String(error);
      if (/no such (table|module)/i.test(message)) return;
      throw error;
    }
  }

  appendMessage(
    sessionId: string,
    role: MessageRole,
    parts: SessionMessage['parts'],
    opts?: SurfaceWriteOpts
  ): SessionMessage {
    const replyTo = this.quoteForAppend(sessionId, role, opts?.replyTo);
    const node = this.insertSurfaceNode({
      sessionId,
      role,
      parts,
      surfaceOp: 'append',
      key: opts?.key,
      expectedWriterRunId: opts?.expectedWriterRunId,
      replyTo
    });
    const message = this.surfaceToMessage(node);
    const session = this.getSession(sessionId);
    if (session) {
      const metadata = captureTaskContext(session, message);
      if (metadata) this.updateSession(sessionId, { metadata, todo: taskContextTodos(metadata) });
    }
    return message;
  }

  appendReplacement(sessionId: string, input: AppendReplacementInput): SessionMessage {
    const wal = this.listSurfaceNodes(sessionId);
    assertSeqStrictlyIncreasing(wal);
    assertReplaceRangeCovered(wal, input.startSeq, input.endSeq);
    assertReplaceRangeClosed(wal, input.startSeq, input.endSeq);
    const node = this.insertSurfaceNode({
      sessionId,
      role: input.role,
      parts: input.parts,
      surfaceOp: 'replace',
      key: input.key,
      replacesStart: input.startSeq,
      replacesEnd: input.endSeq,
      expectedWriterRunId: input.expectedWriterRunId
    });
    return this.surfaceToMessage(node);
  }

  hideByKey(sessionId: string, key: string, opts?: { expectedWriterRunId?: string }): number {
    if (!key) return 0;
    const folded = this.foldMessages(sessionId);
    const targets = folded.filter((m) => m.key === key && m.seq !== undefined);
    for (const message of targets) {
      this.insertSurfaceNode({
        sessionId,
        role: message.role,
        parts: [],
        surfaceOp: 'hide',
        key,
        replacesStart: message.seq,
        replacesEnd: message.seq,
        expectedWriterRunId: opts?.expectedWriterRunId
      });
    }
    return targets.length;
  }

  hideRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
    opts?: { expectedWriterRunId?: string }
  ): SessionMessage {
    const wal = this.listSurfaceNodes(sessionId);
    assertSeqStrictlyIncreasing(wal);
    assertReplaceRangeCovered(wal, startSeq, endSeq);
    const node = this.insertSurfaceNode({
      sessionId,
      role: 'system',
      parts: [],
      surfaceOp: 'hide',
      replacesStart: startSeq,
      replacesEnd: endSeq,
      expectedWriterRunId: opts?.expectedWriterRunId
    });
    return this.surfaceToMessage(node);
  }

  /**
   * Unique packing entry for the model path. Hide/replace ops shadow earlier
   * seqs; hide rows themselves never appear.
   */
  foldMessages(sessionId: string): SessionMessage[] {
    // A read savepoint gives metadata and payload queries one snapshot, including
    // when called inside a writer's existing transaction. No cross-call cache.
    const savepoint = createId('fold');
    this.db.exec(`SAVEPOINT "${savepoint}"`);
    try {
      const rows = this.db.prepare(`SELECT id, session_id, seq, surface_op, replaces_start, replaces_end, key
        FROM session_messages WHERE session_id = ? ORDER BY seq ASC, created_at ASC, id ASC`).all(sessionId) as Array<Record<string, unknown>>;
      // Reuse original coercion and invariant validation without reading raw text.
      const metadata = rows.map(row => this.mapSurfaceRow({...row, parts_json: '[]', role: 'system', created_at: ''}));
      assertSeqStrictlyIncreasing(metadata);
      if (rows.some(row => typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq))) return foldSurface(this.listSurfaceNodes(sessionId));
      const intervals = this.foldShadowIntervals(metadata);
      if (!intervals) return foldSurface(this.listSurfaceNodes(sessionId));
      return this.readVisibleFoldRows(sessionId, intervals).map(row => this.surfaceToMessage(this.mapSurfaceRow(row)));
    } finally {
      this.db.exec(`RELEASE "${savepoint}"`);
    }
  }

  private foldShadowIntervals(nodes: SurfaceNode[]): Array<[number, number]> | undefined {
    const ranges: Array<[number, number]> = [];
    const latestSummary = nodes.filter(node => node.surfaceOp === 'replace' && node.key === 'compact-summary').at(-1)?.seq;
    for (const node of nodes) {
      if (node.surfaceOp === 'replace' && node.key === 'compact-summary' && node.seq !== latestSummary) ranges.push([node.seq, node.seq]);
      if (node.surfaceOp !== 'replace' && node.surfaceOp !== 'hide') continue;
      const start = node.replacesStart, end = node.replacesEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      // Preserve legacy Set-based behavior for unusual values outside safe integers.
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
      if (start! <= end!) ranges.push([start!, end!]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  private readVisibleFoldRows(sessionId: string, intervals: Array<[number, number]>): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    let lower: number | undefined;
    for (const [upper, end] of intervals) {
      for (const row of this.readFoldInterval(sessionId, lower, upper)) rows.push(row);
      lower = end;
    }
    for (const row of this.readFoldInterval(sessionId, lower)) rows.push(row);
    return rows;
  }

  private readFoldInterval(sessionId: string, lower?: number, upper?: number): Array<Record<string, unknown>> {
    const where = ["session_id = ?", "(surface_op IS NULL OR surface_op != 'hide')"];
    const args: Array<string | number> = [sessionId];
    if (lower !== undefined) { where.push('seq > ?'); args.push(lower); }
    if (upper !== undefined) { where.push('seq < ?'); args.push(upper); }
    return this.db.prepare(`SELECT * FROM session_messages WHERE ${where.join(' AND ')} ORDER BY seq ASC, created_at ASC, id ASC`).all(...args) as Array<Record<string, unknown>>;
  }

  /**
   * Full WAL for audit / UI (append + replace rows). Hide ops are not content.
   * The model path must not use this as input.
   */
  hasAssistantOrToolMessage(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM session_messages
         WHERE session_id = ?
           AND role IN ('assistant', 'tool')
           AND (surface_op IS NULL OR surface_op != 'hide')
         LIMIT 1`
      )
      .get(sessionId);
    return Boolean(row);
  }

  listMessages(sessionId: string): SessionMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ?
           AND (surface_op IS NULL OR surface_op != 'hide')
         ORDER BY seq ASC, created_at ASC, id ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.surfaceToMessage(this.mapSurfaceRow(row)));
  }

  /**
   * One page of {@link listMessages} (the Lab transcript), newest first when
   * `beforeSeq` is omitted. `beforeSeq` is exclusive, so the next page starts
   * on the message immediately before this page. Callers that need the whole
   * transcript keep using {@link listMessages}.
   */
  listVisibleMessagesPage(sessionId: string, opts: { limit?: number; beforeSeq?: number } = {}): HistoryPage {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 40)));
    if (!Number.isFinite(limit)) throw new Error('Invalid history limit');
    const where = ['session_id = ?', "(surface_op IS NULL OR surface_op != 'hide')"];
    const args: Array<string | number> = [sessionId];
    if (opts.beforeSeq !== undefined) {
      if (!Number.isSafeInteger(opts.beforeSeq) || opts.beforeSeq < 1) throw new Error('Invalid history cursor');
      where.push('seq < ?');
      args.push(opts.beforeSeq);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE ${where.join(' AND ')}
         ORDER BY seq DESC, created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...args, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const messages = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.surfaceToMessage(this.mapSurfaceRow(row)));
    return { messages, hasMore, nextCursor: hasMore ? messages[0]?.seq ?? null : null };
  }

  /** Raw append history: replacements never destroy the source rows. Bound by an indexed sequence cursor. */
  listHistory(sessionId: string, opts: HistoryOptions = {}): HistoryPage {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    if (!Number.isFinite(limit)) throw new Error('Invalid history limit');
    let source = 'session_messages';
    const where = ["session_messages.session_id = ?", "(surface_op IS NULL OR surface_op = 'append')"];
    const args: (string | number)[] = [sessionId];
    if (opts.beforeSeq !== undefined) {
      if (!Number.isSafeInteger(opts.beforeSeq) || opts.beforeSeq < 1) throw new Error('Invalid history cursor');
      where.push('session_messages.seq < ?'); args.push(opts.beforeSeq);
    }
    const role = historyRole(opts.role);
    if (role) {
      where.push('session_messages.role = ?');
      args.push(role);
    }
    for (const [value, operator] of [[opts.from, '>='], [opts.to, '<=']] as const) {
      if (value !== undefined) {
        const stamp = new Date(value);
        if (!Number.isFinite(stamp.getTime())) throw new Error('Invalid history time');
        where.push(`session_messages.created_at ${operator} ?`); args.push(stamp.toISOString());
      }
    }
    if (opts.query?.trim()) {
      where.push("EXISTS (SELECT 1 FROM json_each(parts_json) AS part WHERE (json_extract(part.value, '$.text') LIKE ? ESCAPE '\\' OR json_extract(part.value, '$.content') LIKE ? ESCAPE '\\'))");
      const pattern = '%' + opts.query.trim().replace(/[\\%_]/g, '\\$&') + '%'; args.push(pattern, pattern);
      if (this.historyFts === undefined) {
        try { this.db.prepare('SELECT 1 FROM session_history_fts LIMIT 0').all(); this.historyFts = true; } catch { this.historyFts = false; }
      }
      // The FTS corpus stores JSON, so only characters preserved verbatim in JSON
      // are eligible for literal MATCH. Exact extracted-part matching stays authoritative.
      const query = opts.query.trim();
      const literalCandidate = query.length >= 3 && /^[\x20-\x7e]+$/.test(query) && !/["\\]/.test(query);
      if (this.historyFts && literalCandidate) {
        // DISTINCT protects stable pages even if a legacy FTS table has duplicate rows.
        // CROSS JOIN starts from selective trigram candidates, then looks up message ids.
        source = '(SELECT DISTINCT message_id FROM session_history_fts WHERE session_history_fts MATCH ?) AS candidate CROSS JOIN session_messages ON session_messages.id = candidate.message_id';
        args.unshift('"' + query + '"');
      } else if (this.historyFts && query.length >= 3 && !/[\\%_"\x00-\x1f]/.test(opts.query)) {
        where.push('id IN (SELECT message_id FROM session_history_fts WHERE text LIKE ?)'); args.push(pattern);
      }

    }
    const rows = this.db.prepare(`SELECT session_messages.* FROM ${source} WHERE ${where.join(' AND ')} ORDER BY session_messages.seq DESC LIMIT ?`).all(...args, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(row => this.surfaceToMessage(this.mapSurfaceRow(row)));
    return { messages, hasMore, nextCursor: hasMore ? messages[0]?.seq ?? null : null };
  }

  readHistory(sessionId: string, seq: number, before = 5, after = 5): HistoryContext | undefined {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid history sequence');
    const raw = "(surface_op IS NULL OR surface_op = 'append')";
    const row = this.db.prepare(`SELECT * FROM session_messages WHERE session_id = ? AND seq = ? AND ${raw}`).get(sessionId, seq) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const bound = (n: number) => Number.isFinite(n) ? Math.min(50, Math.max(0, Math.floor(n))) : 5;
    const older = this.db.prepare(`SELECT * FROM session_messages WHERE session_id = ? AND seq < ? AND ${raw} ORDER BY seq DESC LIMIT ?`).all(sessionId, seq, bound(before)) as Array<Record<string, unknown>>;
    const newer = this.db.prepare(`SELECT * FROM session_messages WHERE session_id = ? AND seq > ? AND ${raw} ORDER BY seq ASC LIMIT ?`).all(sessionId, seq, bound(after)) as Array<Record<string, unknown>>;
    const map = (r: Record<string, unknown>) => this.surfaceToMessage(this.mapSurfaceRow(r));
    return { message: map(row), messages: [...older.reverse(), row, ...newer].map(map) };
  }

  /** Resolve an original source ref with one indexed id lookup, never hydrate the whole WAL. */
  readHistoryById(sessionId: string, messageId: string): SessionMessage | undefined {
    const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ? AND session_id = ? AND (surface_op IS NULL OR surface_op = 'append')").get(messageId, sessionId) as Record<string, unknown> | undefined;
    return row ? this.surfaceToMessage(this.mapSurfaceRow(row)) : undefined;
  }

  listSurfaceNodes(sessionId: string): SurfaceNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC, created_at ASC, id ASC`
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    const nodes = rows.map((row) => this.mapSurfaceRow(row));
    assertSeqStrictlyIncreasing(nodes);
    return nodes;
  }

  /** Compact helpers: throw if fold currently has an unmatched tool_call. */
  assertFoldClosedForCompact(sessionId: string): void {
    assertNoOpenToolWaveForCompact(this.foldMessages(sessionId));
  }

  copyWalPrefix(fromId: string, toId: string, endSeq: number): number {
    const nodes = this.listSurfaceNodes(fromId).filter((n) => n.seq <= endSeq);
    const insert = this.db.prepare(`
      INSERT INTO session_messages (
        id, session_id, role, parts_json, created_at,
        seq, key, surface_op, replaces_start, replaces_end, reply_to_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const node of nodes) {
      insert.run(
        createId('msg'),
        toId,
        node.role,
        serializeJson(node.parts),
        node.createdAt,
        node.seq,
        node.key ?? null,
        node.surfaceOp,
        node.replacesStart ?? null,
        node.replacesEnd ?? null,
        node.replyTo ? serializeJson(node.replyTo) : null
      );
    }
    if (nodes.length > 0) {
      this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(nowIso(), toId);
    }
    return nodes.length;
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS m FROM session_messages WHERE session_id = ?`)
      .get(sessionId) as { m: number | null } | undefined;
    return (row?.m ?? 0) + 1;
  }

  private quoteForAppend(sessionId: string, role: MessageRole, raw: unknown): MessageReplyTo | undefined {
    if (raw == null) return undefined;
    if (role !== 'user') throw new ValidationError('replyTo is only valid on a user message');
    const quote = normalizeReplyQuote(raw);
    const row = this.db
      .prepare(
        `SELECT role FROM session_messages
         WHERE id = ? AND session_id = ? AND (surface_op IS NULL OR surface_op != 'hide')`
      )
      .get(quote.messageId, sessionId) as { role: string } | undefined;
    if (!row) throw new ValidationError('replyTo message not found');
    if (row.role !== 'assistant') throw new ValidationError('replyTo must quote a bot reply');
    return quote;
  }

  private insertSurfaceNode(input: {
    sessionId: string;
    role: MessageRole;
    parts: SessionMessage['parts'];
    surfaceOp: SurfaceOp;
    key?: string;
    replacesStart?: number;
    replacesEnd?: number;
    expectedWriterRunId?: string;
    replyTo?: MessageReplyTo;
  }): SurfaceNode {
    return this.transaction(() => {
    this.assertCurrentWriter(input.sessionId);
    const session = this.getSession(input.sessionId);
    if (input.expectedWriterRunId !== undefined && input.expectedWriterRunId !== session?.activeWriterRunId) {
      throw new WriterClaimError(input.sessionId, input.expectedWriterRunId, session?.activeWriterRunId);
    }
    assertWriterClaim({
      sessionId: input.sessionId,
      activeWriterRunId: session?.activeWriterRunId,
      expectedWriterRunId: input.expectedWriterRunId,
      boundWriterRunId: this.writerBindings.get(input.sessionId)
    });
    const now = nowIso();
    const node: SurfaceNode = {
      id: createId('msg'),
      sessionId: input.sessionId,
      seq: this.nextSeq(input.sessionId),
      key: input.key,
      surfaceOp: input.surfaceOp,
      replacesStart: input.replacesStart,
      replacesEnd: input.replacesEnd,
      role: input.role,
      parts: input.parts,
      createdAt: now,
      ...(input.replyTo ? { replyTo: input.replyTo } : {})
    };

    this.db
      .prepare(`
        INSERT INTO session_messages (
          id, session_id, role, parts_json, created_at,
          seq, key, surface_op, replaces_start, replaces_end, reply_to_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        node.id,
        node.sessionId,
        node.role,
        serializeJson(node.parts),
        node.createdAt,
        node.seq,
        node.key ?? null,
        node.surfaceOp,
        node.replacesStart ?? null,
        node.replacesEnd ?? null,
        node.replyTo ? serializeJson(node.replyTo) : null
      );

    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(node.createdAt, input.sessionId);
    return node;
    });
  }

  private mapSurfaceRow(row: Record<string, unknown>): SurfaceNode {
    const seqRaw = row.seq;
    const seq = typeof seqRaw === 'number' ? seqRaw : Number(seqRaw);
    const key = optionalString(row.key);
    const replacesStart =
      row.replaces_start == null ? undefined : Number(row.replaces_start);
    const replacesEnd = row.replaces_end == null ? undefined : Number(row.replaces_end);
    const replyTo = replyToFromColumn(row.reply_to_json);
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      seq,
      key,
      surfaceOp: parseSurfaceOp(row.surface_op),
      replacesStart: Number.isFinite(replacesStart as number) ? replacesStart : undefined,
      replacesEnd: Number.isFinite(replacesEnd as number) ? replacesEnd : undefined,
      role: String(row.role) as MessageRole,
      parts: parseJson<SessionMessage['parts']>(String(row.parts_json)) ?? [],
      createdAt: String(row.created_at),
      ...(replyTo ? { replyTo } : {})
    };
  }

  private surfaceToMessage(node: SurfaceNode): SessionMessage {
    return {
      id: node.id,
      sessionId: node.sessionId,
      role: node.role,
      parts: node.parts,
      createdAt: node.createdAt,
      seq: node.seq,
      ...(node.key ? { key: node.key } : {}),
      ...(node.replyTo ? { replyTo: node.replyTo } : {})
    };
  }

  private mapSessionRow(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      mode: String(row.mode) as SessionRecord['mode'],
      status: String(row.status) as SessionStatus,
      agentId: String(row.agent_id),
      taskId: optionalString(row.task_id),
      workspaceId: optionalString(row.workspace_id),
      parentSessionId: optionalString(row.parent_session_id),
      background: intToBool(row.background),
      summary: optionalString(row.summary),
      todo: parseJson<SessionRecord['todo']>(String(row.todo_json)) ?? [],
      metadata: parseJson<Record<string, unknown>>(String(row.metadata_json)) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      activeWriterRunId: optionalString(row.active_writer_run_id)
    };
  }
}

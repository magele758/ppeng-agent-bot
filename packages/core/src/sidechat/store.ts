import type { DatabaseSync } from 'node:sqlite';
import { tryAcquireFdLock, type HeldFdLock } from '../teams/fd-lock.js';
import { isDeepStrictEqual } from 'node:util';
import type { SidechatAnchor, SidechatDetail, SidechatGrasp, SidechatStatus } from '@ppeng/api-types';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { createId, nowIso } from '../id.js';
import { readMessages, readThread, threadColumns, type ThreadRow, type TurnRow } from './rows.js';
import { searchSidechats, type SearchOptions } from './search.js';

export interface StartSidechatTurn {
  sessionId: string;
  messageId: string;
  agentId: string;
  botId?: string;
  anchor: SidechatAnchor;
  question: string;
  requestId: string;
  threadId?: string;
  retry?: boolean;
  attemptId?: string;
}

function assignRevision(
  sets: string[],
  args: Array<string | null>,
  patch: { grasp?: SidechatGrasp; note?: string; title?: string }
): void {
  if (patch.grasp) {
    sets.push('grasp=?');
    args.push(patch.grasp);
  }
  if (patch.note !== undefined) {
    sets.push('note=?', 'note_revision=note_revision+1');
    args.push(patch.note);
  }
  if (patch.title !== undefined) {
    sets.push('title=?');
    args.push(patch.title);
  }
}

export class SidechatStore {
  private hasFts?: boolean;
  private worker?: { slot: number; lock: HeldFdLock };

  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string
  ) {}

  releaseWorker(): void {
    this.worker?.lock.release();
    this.worker = undefined;
  }

  // Keep one kernel-held lock per live writer, not one file per turn. A closed
  // connection or crashed worker releases the slot even if its PID is reused.
  private workerSlot(): number {
    if (this.dbPath === ':memory:') return 0;
    if (this.worker) return this.worker.slot;
    for (let slot = 0; ; slot++) {
      const lock = tryAcquireFdLock(this.workerPath(slot));
      if (lock) {
        try {
          this.interruptSlot(slot);
        } catch (error) {
          lock.release();
          throw error;
        }
        this.worker = { slot, lock };
        return slot;
      }
    }
  }

  private workerPath(slot: number): string {
    return this.dbPath + '.sidechat-worker-' + slot + '.lock.db';
  }

  private interruptSlot(slot: number): void {
    this.db
      .prepare(
        `UPDATE sidechat_turns
         SET status = 'failed', error = 'interrupted', run_id = NULL, worker_slot = NULL
         WHERE worker_slot = ? AND status = 'generating'`
      )
      .run(slot);
  }

  sourceSessionId(owner: string, id: string): string | undefined {
    return this.db.prepare('SELECT session_id FROM sidechat_threads WHERE owner=? AND id=?').get(owner, id)
      ?.session_id as string | undefined;
  }

  get(owner: string, visible: readonly string[], id: string): SidechatDetail | undefined {
    // A savepoint pins both reads to the same snapshot and composes with start()'s write transaction.
    this.db.exec('SAVEPOINT sidechat_detail');
    try {
      const row = this.db
        .prepare(
          `SELECT ${threadColumns}
           FROM sidechat_threads t
           WHERE t.id = ? AND t.owner = ? AND t.session_id IN (SELECT value FROM json_each(?))`
        )
        .get(id, owner, JSON.stringify(visible)) as unknown as ThreadRow | undefined;
      if (!row) return undefined;
      const turns = this.db
        .prepare('SELECT * FROM sidechat_turns WHERE thread_id=? ORDER BY n')
        .all(id) as unknown as TurnRow[];
      return { ...readThread(row), messages: turns.flatMap(readMessages) };
    } finally {
      this.db.exec('RELEASE sidechat_detail');
    }
  }

  /** The caller must first authorize this session. Global queries use search() instead. */
  list(owner: string, sessionId: string) {
    const rows = this.db
      .prepare(
        `SELECT ${threadColumns} FROM sidechat_threads t
         WHERE owner = ? AND session_id = ?
         ORDER BY updated DESC, ordinal DESC`
      )
      .all(owner, sessionId) as unknown as ThreadRow[];
    return rows.map(readThread);
  }

  search(owner: string, visible: readonly string[], opts: SearchOptions = {}) {
    this.hasFts ??= !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sidechat_fts'").get();
    return searchSidechats(this.db, owner, visible, opts, this.hasFts);
  }

  start(owner: string, input: StartSidechatTurn): { thread: SidechatDetail; runId: string | null } {
    if (!input.question.trim() || !input.requestId.trim()) {
      throw new ValidationError('A question and requestId are required');
    }
    const slot = this.workerSlot();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const threadId = input.threadId ?? this.findOrCreate(owner, input);
      const pointer = this.sourceSessionId(owner, threadId);
      if (pointer !== input.sessionId) throw new NotFoundError('sidechat');
      const runId = this.claim(threadId, input, slot);
      if (runId) this.touch(threadId);
      const thread = this.get(owner, [pointer], threadId)!;
      this.db.exec('COMMIT');
      return { thread, runId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private findOrCreate(owner: string, input: StartSidechatTurn): string {
    const prior = this.db
      .prepare(
        'SELECT id,message_id,anchor FROM sidechat_threads WHERE owner=? AND session_id=? AND create_request=?'
      )
      .get(owner, input.sessionId, input.requestId);
    if (prior) {
      if (
        prior.message_id !== input.messageId ||
        !isDeepStrictEqual(JSON.parse(String(prior.anchor)), JSON.parse(JSON.stringify(input.anchor)))
      ) {
        throw new ConflictError('Creation request already belongs to another source');
      }
      return String(prior.id);
    }
    if (input.retry) throw new NotFoundError('sidechat');
    const id = createId('side');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sidechat_threads (
           id, owner, session_id, create_request, message_id, agent_id, bot_id,
           ordinal, title, anchor, created, updated
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, coalesce(max(ordinal), 0) + 1, ?, ?, ?, ?
         FROM sidechat_threads WHERE owner = ? AND session_id = ?`
      )
      .run(
        id,
        owner,
        input.sessionId,
        input.requestId,
        input.messageId,
        input.agentId,
        input.botId ?? null,
        input.question.trim().slice(0, 120),
        JSON.stringify(input.anchor),
        now,
        now,
        owner,
        input.sessionId
      );
    return id;
  }

  private claim(threadId: string, input: StartSidechatTurn, slot: number): string | null {
    const prior = this.db
      .prepare('SELECT * FROM sidechat_turns WHERE thread_id=? AND request_id=?')
      .get(threadId, input.requestId) as unknown as TurnRow | undefined;
    if (!prior) return this.insertTurn(threadId, input, slot);
    if (prior.question !== input.question) {
      throw new ConflictError('Request id already belongs to another question');
    }
    if (!input.retry) return null;
    return this.retryTurn(prior, slot, input.attemptId);
  }

  private insertTurn(threadId: string, input: StartSidechatTurn, slot: number): string {
    if (input.retry) throw new NotFoundError('sidechat turn');
    const busy = this.db
      .prepare("SELECT 1 FROM sidechat_turns WHERE thread_id=? AND status='generating'")
      .get(threadId);
    if (busy) throw new ConflictError('Sidechat reply is still generating');
    const runId = createId('scrun');
    this.db
      .prepare(
        `INSERT INTO sidechat_turns (id, thread_id, request_id, question, status, run_id, worker_slot, created)
         VALUES (?, ?, ?, ?, 'generating', ?, ?, ?)`
      )
      .run(createId('scturn'), threadId, input.requestId, input.question, runId, slot, nowIso());
    return runId;
  }

  private retryTurn(turn: TurnRow, slot: number, attemptId?: string): string | null {
    if (!attemptId?.trim()) throw new ValidationError('Retry attemptId is required');
    const seen = this.db
      .prepare('SELECT 1 FROM sidechat_retries WHERE turn_id=? AND attempt_id=?')
      .get(turn.id, attemptId);
    if (seen) return null;
    const latest = this.db
      .prepare('SELECT id FROM sidechat_turns WHERE thread_id=? ORDER BY n DESC LIMIT 1')
      .get(turn.thread_id);
    if (latest?.id !== turn.id || !['failed', 'stopped'].includes(turn.status)) {
      throw new ConflictError('Only the latest failed or stopped turn can be retried');
    }
    const runId = createId('scrun');
    this.db.prepare('INSERT INTO sidechat_retries(turn_id,attempt_id) VALUES(?,?)').run(turn.id, attemptId);
    this.db
      .prepare(
        "UPDATE sidechat_turns SET status='generating',answer='',error=NULL,run_id=?,worker_slot=? WHERE id=?"
      )
      .run(runId, slot, turn.id);
    return runId;
  }

  private touch(id: string): void {
    this.db.prepare('UPDATE sidechat_threads SET updated=? WHERE id=?').run(nowIso(), id);
  }

  activeRun(threadId: string, requestId: string): string | undefined {
    return this.db
      .prepare("SELECT run_id FROM sidechat_turns WHERE thread_id=? AND request_id=? AND status='generating'")
      .get(threadId, requestId)?.run_id as string | undefined;
  }

  progress(threadId: string, runId: string, text: string): boolean {
    return (
      this.db
        .prepare("UPDATE sidechat_turns SET answer=? WHERE thread_id=? AND run_id=? AND status='generating'")
        .run(text, threadId, runId).changes === 1
    );
  }

  finish(
    threadId: string,
    runId: string,
    status: Exclude<SidechatStatus, 'generating'>,
    text: string,
    error?: string
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `UPDATE sidechat_turns
           SET status = ?, answer = ?, error = ?, run_id = NULL, worker_slot = NULL
           WHERE thread_id = ? AND run_id = ? AND status = 'generating'`
        )
        .run(status, text, error ?? null, threadId, runId);
      const changed = result.changes === 1;
      if (changed) this.touch(threadId);
      this.db.exec('COMMIT');
      return changed;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }

  revise(
    owner: string,
    id: string,
    patch: { grasp?: SidechatGrasp; note?: string; title?: string }
  ): boolean {
    const sets: string[] = [];
    const args: Array<string | null> = [];
    assignRevision(sets, args, patch);
    if (!sets.length) return false;
    sets.push('updated=?');
    args.push(nowIso(), owner, id);
    return (
      this.db.prepare(`UPDATE sidechat_threads SET ${sets.join(', ')} WHERE owner=? AND id=?`).run(...args)
        .changes === 1
    );
  }

  beginNote(owner: string, id: string): number {
    const row = this.db.prepare(`UPDATE sidechat_threads SET note_revision=note_revision+1
      WHERE owner=? AND id=? RETURNING note_revision`).get(owner, id);
    if (!row) throw new NotFoundError('Sidechat');
    return Number(row.note_revision);
  }

  finishNote(owner: string, id: string, revision: number, note: string): boolean {
    return this.db.prepare(`UPDATE sidechat_threads SET note=?, updated=?, note_revision=note_revision+1
      WHERE owner=? AND id=? AND note_revision=?`).run(note, nowIso(), owner, id, revision).changes === 1;
  }

  remove(owner: string, id: string): boolean {
    return (
      this.db.prepare('DELETE FROM sidechat_threads WHERE owner = ? AND id = ?').run(owner, id).changes === 1
    );
  }

  /** Run at daemon startup. A live connection keeps its slot across concurrent daemon starts. */
  recoverInterrupted(): void {
    if (this.dbPath === ':memory:') return;
    const rows = this.db
      .prepare("SELECT DISTINCT worker_slot FROM sidechat_turns WHERE status='generating'")
      .all();
    for (const row of rows) {
      const slot = Number(row.worker_slot);
      const lock = tryAcquireFdLock(this.workerPath(slot));
      if (!lock) continue;
      try {
        this.interruptSlot(slot);
      } finally {
        lock.release();
      }
    }
  }
}

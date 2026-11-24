/**
 * SQLite-backed DurableJournalPort (`node:sqlite` — full+ only, never imported by `mini`).
 *
 * Designed to share the host's `DatabaseSync` instance so `session_messages`
 * and `durable_steps` commit atomically inside a single SQLite transaction.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { createId, nowIso } from '../helpers.js';
import { createInitialDurableKernelState, normalizeDurableKernelState } from './step-helpers.js';
import type {
  CommitDurableStepPatch,
  CompensationSpec,
  DurableJournalPort,
  DurableRunRecord,
  DurableRunStatus,
  DurableSignalRecord,
  DurableStepPhase,
  DurableStepRecord,
  PlanDurableStepInput,
  ToolParkDirective,
  UpdateDurableRunPatch,
} from './types.js';

export const DURABLE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS durable_runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_run_id TEXT,
    fencing_epoch INTEGER NOT NULL,
    status TEXT NOT NULL,
    tx_scope_id TEXT,
    passed_pivot INTEGER NOT NULL DEFAULT 0,
    restarts INTEGER NOT NULL DEFAULT 0,
    kernel_state_json TEXT NOT NULL,
    error_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_durable_runs_session ON durable_runs(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_durable_runs_status ON durable_runs(status);
  CREATE INDEX IF NOT EXISTS idx_durable_runs_parent ON durable_runs(parent_run_id);

  CREATE TABLE IF NOT EXISTS durable_steps (
    step_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    wave_index INTEGER NOT NULL,
    fencing_epoch INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    tool_call_id TEXT,
    tool_name TEXT,
    idempotency_key TEXT NOT NULL,
    effect_class TEXT NOT NULL,
    replay_policy TEXT NOT NULL,
    phase TEXT NOT NULL,
    args_hash TEXT,
    message_seq INTEGER,
    snapshot_ref TEXT,
    receipt_json TEXT,
    compensation_spec_json TEXT,
    park_json TEXT,
    error_text TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_steps_run_call
    ON durable_steps(run_id, turn, wave_index, tool_call_id) WHERE tool_call_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_durable_steps_run_turn ON durable_steps(run_id, turn, wave_index);
  CREATE INDEX IF NOT EXISTS idx_durable_steps_idem ON durable_steps(idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_durable_steps_phase ON durable_steps(session_id, phase);

  CREATE TABLE IF NOT EXISTS durable_memos (
    step_id TEXT NOT NULL,
    memo_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (step_id, memo_key)
  );

  CREATE TABLE IF NOT EXISTS durable_signals (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    signal_name TEXT NOT NULL,
    signal_key TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id, signal_name, signal_key)
  );
`;

export function ensureDurableSchema(db: DatabaseSync): void {
  db.exec(DURABLE_SCHEMA_SQL);
}

function parseJsonOr<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function decodeRunRow(row: Record<string, unknown>): DurableRunRecord {
  const rec: DurableRunRecord = {
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    fencingEpoch: Number(row.fencing_epoch),
    status: String(row.status) as DurableRunStatus,
    passedPivot: Number(row.passed_pivot) === 1,
    restarts: Number(row.restarts),
    kernelState: normalizeDurableKernelState(parseJsonOr(row.kernel_state_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (typeof row.parent_run_id === 'string') rec.parentRunId = row.parent_run_id;
  if (typeof row.tx_scope_id === 'string') rec.txScopeId = row.tx_scope_id;
  if (typeof row.error_text === 'string') rec.errorText = row.error_text;
  return rec;
}

function decodeStepRow(row: Record<string, unknown>): DurableStepRecord {
  const rec: DurableStepRecord = {
    stepId: String(row.step_id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    turn: Number(row.turn),
    waveIndex: Number(row.wave_index),
    fencingEpoch: typeof row.fencing_epoch === 'number' ? row.fencing_epoch : 1,
    kind: String(row.kind) as DurableStepRecord['kind'],
    idempotencyKey: String(row.idempotency_key),
    effectClass: String(row.effect_class) as DurableStepRecord['effectClass'],
    replayPolicy: String(row.replay_policy) as DurableStepRecord['replayPolicy'],
    phase: String(row.phase) as DurableStepPhase,
    createdAt: String(row.created_at),
  };
  if (typeof row.tool_call_id === 'string') rec.toolCallId = row.tool_call_id;
  if (typeof row.tool_name === 'string') rec.toolName = row.tool_name;
  if (typeof row.args_hash === 'string') rec.argsHash = row.args_hash;
  if (typeof row.message_seq === 'number') rec.messageSeq = row.message_seq;
  if (typeof row.snapshot_ref === 'string') rec.snapshotRef = row.snapshot_ref;
  const receipt = parseJsonOr<Record<string, unknown>>(row.receipt_json);
  if (receipt) rec.receipt = receipt;
  const comp = parseJsonOr<CompensationSpec>(row.compensation_spec_json);
  if (comp) rec.compensationSpec = comp;
  const park = parseJsonOr<ToolParkDirective>(row.park_json);
  if (park) rec.park = park;
  if (typeof row.error_text === 'string') rec.errorText = row.error_text;
  if (typeof row.started_at === 'string') rec.startedAt = row.started_at;
  if (typeof row.finished_at === 'string') rec.finishedAt = row.finished_at;
  return rec;
}

function decodeSignalRow(row: Record<string, unknown>): DurableSignalRecord {
  return {
    runId: String(row.run_id),
    stepId: String(row.step_id),
    signalName: String(row.signal_name),
    signalKey: String(row.signal_key),
    state: String(row.state) as DurableSignalRecord['state'],
    payload: parseJsonOr(row.payload_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteDurableJournal implements DurableJournalPort {
  private txDepth = 0;

  constructor(private readonly db: DatabaseSync) {
    ensureDurableSchema(db);
  }

  withTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0 || this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  beginRun(input: {
    runId: string;
    sessionId: string;
    parentRunId?: string;
    txScopeId?: string;
    kernelState?: DurableRunRecord['kernelState'];
  }): DurableRunRecord {
    const existing = this.getRun(input.runId);
    if (existing) return existing;
    const prev = this.getLatestRunForSession(input.sessionId);
    const now = nowIso();
    const epoch = (prev?.fencingEpoch ?? 0) + 1;
    const state = input.kernelState ? normalizeDurableKernelState(input.kernelState) : createInitialDurableKernelState();
    this.db
      .prepare(
        `INSERT INTO durable_runs (
          run_id, session_id, parent_run_id, fencing_epoch, status,
          tx_scope_id, passed_pivot, restarts, kernel_state_json, error_text,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, 0, 0, ?, NULL, ?, ?)`
      )
      .run(
        input.runId,
        input.sessionId,
        input.parentRunId ?? null,
        epoch,
        input.txScopeId ?? null,
        JSON.stringify(state),
        now,
        now
      );
    return this.getRun(input.runId)!;
  }

  getRun(runId: string): DurableRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM durable_runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeRunRow(row) : undefined;
  }

  getLatestRunForSession(sessionId: string): DurableRunRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM durable_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? decodeRunRow(row) : undefined;
  }

  listRunsForSession(sessionId: string, limit = 20): DurableRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM durable_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map(decodeRunRow);
  }

  listRunsByStatus(statuses: readonly DurableRunStatus[]): DurableRunRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM durable_runs WHERE status IN (${placeholders}) ORDER BY rowid ASC`)
      .all(...statuses) as Array<Record<string, unknown>>;
    return rows.map(decodeRunRow);
  }

  listChildRuns(parentRunId: string): DurableRunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM durable_runs WHERE parent_run_id = ? ORDER BY rowid ASC`)
      .all(parentRunId) as Array<Record<string, unknown>>;
    return rows.map(decodeRunRow);
  }

  updateRun(runId: string, patch: UpdateDurableRunPatch): DurableRunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error(`Durable run not found: ${runId}`);
    const nextState = patch.kernelState ? normalizeDurableKernelState(patch.kernelState) : current.kernelState;
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE durable_runs
         SET status = ?, fencing_epoch = ?, tx_scope_id = ?, passed_pivot = ?,
             restarts = ?, kernel_state_json = ?, error_text = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(
        patch.status ?? current.status,
        patch.fencingEpoch ?? current.fencingEpoch,
        patch.txScopeId !== undefined ? patch.txScopeId : (current.txScopeId ?? null),
        (patch.passedPivot ?? current.passedPivot) ? 1 : 0,
        patch.restarts ?? current.restarts,
        JSON.stringify(nextState),
        patch.errorText !== undefined ? patch.errorText : (current.errorText ?? null),
        now,
        runId
      );
    return this.getRun(runId)!;
  }

  planStep(input: PlanDurableStepInput): DurableStepRecord {
    if (input.toolCallId) {
      const existing = this.getStepByToolCall(input.runId, input.toolCallId, input.turn);
      if (existing) return existing;
    }
    const stepId = input.stepId ?? createId('dstep');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO durable_steps (
          step_id, run_id, session_id, turn, wave_index, fencing_epoch, kind,
          tool_call_id, tool_name, idempotency_key, effect_class, replay_policy,
          phase, args_hash, snapshot_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)`
      )
      .run(
        stepId,
        input.runId,
        input.sessionId,
        input.turn,
        input.waveIndex,
        input.fencingEpoch ?? 1,
        input.kind,
        input.toolCallId ?? null,
        input.toolName ?? null,
        input.idempotencyKey,
        input.effectClass,
        input.replayPolicy,
        input.argsHash ?? null,
        input.snapshotRef ?? null,
        now
      );
    return this.getStep(stepId)!;
  }

  getStep(stepId: string): DurableStepRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM durable_steps WHERE step_id = ?`).get(stepId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeStepRow(row) : undefined;
  }

  getStepByToolCall(runId: string, toolCallId: string, turn?: number): DurableStepRecord | undefined {
    const row = (
      turn !== undefined
        ? this.db
            .prepare(`SELECT * FROM durable_steps WHERE run_id = ? AND turn = ? AND tool_call_id = ? ORDER BY rowid DESC LIMIT 1`)
            .get(runId, turn, toolCallId)
        : this.db
            .prepare(`SELECT * FROM durable_steps WHERE run_id = ? AND tool_call_id = ? ORDER BY rowid DESC LIMIT 1`)
            .get(runId, toolCallId)
    ) as Record<string, unknown> | undefined;
    return row ? decodeStepRow(row) : undefined;
  }

  listSteps(runId: string): DurableStepRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM durable_steps WHERE run_id = ? ORDER BY rowid ASC`)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(decodeStepRow);
  }

  markStepDispatched(stepId: string, opts?: { snapshotRef?: string; startedAt?: string }): DurableStepRecord {
    const current = this.getStep(stepId);
    if (!current) throw new Error(`Durable step not found: ${stepId}`);
    this.db
      .prepare(`UPDATE durable_steps SET phase = 'dispatched', snapshot_ref = ?, started_at = ? WHERE step_id = ?`)
      .run(
        opts?.snapshotRef !== undefined ? opts.snapshotRef : (current.snapshotRef ?? null),
        opts?.startedAt ?? nowIso(),
        stepId
      );
    return this.getStep(stepId)!;
  }

  commitStep(stepId: string, patch?: CommitDurableStepPatch): DurableStepRecord {
    const current = this.getStep(stepId);
    if (!current) throw new Error(`Durable step not found: ${stepId}`);
    this.db
      .prepare(
        `UPDATE durable_steps
         SET phase = 'committed', message_seq = ?, snapshot_ref = ?,
             receipt_json = ?, compensation_spec_json = ?, finished_at = ?
         WHERE step_id = ?`
      )
      .run(
        patch?.messageSeq !== undefined ? patch.messageSeq : (current.messageSeq ?? null),
        patch?.snapshotRef !== undefined ? patch.snapshotRef : (current.snapshotRef ?? null),
        patch?.receipt !== undefined ? JSON.stringify(patch.receipt) : (current.receipt ? JSON.stringify(current.receipt) : null),
        patch?.compensationSpec !== undefined
          ? JSON.stringify(patch.compensationSpec)
          : (current.compensationSpec ? JSON.stringify(current.compensationSpec) : null),
        patch?.finishedAt ?? nowIso(),
        stepId
      );
    return this.getStep(stepId)!;
  }

  failStep(stepId: string, errorText: string, patch?: { messageSeq?: number }): DurableStepRecord {
    const current = this.getStep(stepId);
    if (!current) throw new Error(`Durable step not found: ${stepId}`);
    this.db
      .prepare(`UPDATE durable_steps SET phase = 'failed', error_text = ?, message_seq = ?, finished_at = ? WHERE step_id = ?`)
      .run(errorText, patch?.messageSeq ?? current.messageSeq ?? null, nowIso(), stepId);
    return this.getStep(stepId)!;
  }

  markStepUnknown(stepId: string, reason: string): DurableStepRecord {
    this.db.prepare(`UPDATE durable_steps SET phase = 'unknown', error_text = ? WHERE step_id = ?`).run(reason, stepId);
    const updated = this.getStep(stepId);
    if (!updated) throw new Error(`Durable step not found: ${stepId}`);
    return updated;
  }

  parkStep(stepId: string, park: ToolParkDirective): DurableStepRecord {
    this.db
      .prepare(`UPDATE durable_steps SET phase = 'parked', park_json = ? WHERE step_id = ?`)
      .run(JSON.stringify(park), stepId);
    const updated = this.getStep(stepId);
    if (!updated) throw new Error(`Durable step not found: ${stepId}`);
    return updated;
  }

  updateStepPhase(
    stepId: string,
    phase: DurableStepPhase,
    patch?: { errorText?: string; receipt?: Record<string, unknown>; snapshotRef?: string }
  ): DurableStepRecord {
    const current = this.getStep(stepId);
    if (!current) throw new Error(`Durable step not found: ${stepId}`);
    this.db
      .prepare(
        `UPDATE durable_steps
         SET phase = ?, error_text = ?, receipt_json = ?, snapshot_ref = ?
         WHERE step_id = ?`
      )
      .run(
        phase,
        patch?.errorText !== undefined ? patch.errorText : (current.errorText ?? null),
        patch?.receipt !== undefined ? JSON.stringify(patch.receipt) : (current.receipt ? JSON.stringify(current.receipt) : null),
        patch?.snapshotRef !== undefined ? patch.snapshotRef : (current.snapshotRef ?? null),
        stepId
      );
    return this.getStep(stepId)!;
  }

  memo<T>(stepId: string, key: string, value: T): T {
    const existing = this.getMemo<T>(stepId, key);
    if (existing !== undefined) return existing;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO durable_memos (step_id, memo_key, value_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(stepId, key, JSON.stringify(value), nowIso());
    return this.getMemo<T>(stepId, key) ?? value;
  }

  getMemo<T = unknown>(stepId: string, key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM durable_memos WHERE step_id = ? AND memo_key = ?`)
      .get(stepId, key) as { value_json?: unknown } | undefined;
    return parseJsonOr<T>(row?.value_json);
  }

  deliverSignal(input: {
    runId: string;
    stepId: string;
    signalName: string;
    signalKey: string;
    payload: unknown;
  }): { status: 'delivered' | 'duplicate' | 'closed' } {
    const run = this.getRun(input.runId);
    if (!run || ['completed', 'failed', 'aborted', 'rolled_back'].includes(run.status)) {
      return { status: 'closed' };
    }
    const existing = this.readSignal(input.runId, input.stepId, input.signalName, input.signalKey);
    if (existing) {
      return { status: existing.state === 'expired' ? 'closed' : 'duplicate' };
    }
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO durable_signals (
          run_id, step_id, signal_name, signal_key, state, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(input.runId, input.stepId, input.signalName, input.signalKey, JSON.stringify(input.payload), now, now);
    return { status: 'delivered' };
  }

  readSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM durable_signals
         WHERE run_id = ? AND step_id = ? AND signal_name = ? AND signal_key = ?`
      )
      .get(runId, stepId, signalName, signalKey) as Record<string, unknown> | undefined;
    return row ? decodeSignalRow(row) : undefined;
  }

  listSignals(runId: string): DurableSignalRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM durable_signals WHERE run_id = ? ORDER BY rowid ASC`)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(decodeSignalRow);
  }

  consumeSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined {
    const existing = this.readSignal(runId, stepId, signalName, signalKey);
    if (!existing || existing.state !== 'pending') return undefined;
    this.db
      .prepare(
        `UPDATE durable_signals SET state = 'consumed', updated_at = ?
         WHERE run_id = ? AND step_id = ? AND signal_name = ? AND signal_key = ? AND state = 'pending'`
      )
      .run(nowIso(), runId, stepId, signalName, signalKey);
    return this.readSignal(runId, stepId, signalName, signalKey);
  }

  expireSignals(runId: string, stepId: string): number {
    const result = this.db
      .prepare(
        `UPDATE durable_signals SET state = 'expired', updated_at = ?
         WHERE run_id = ? AND step_id = ? AND state = 'pending'`
      )
      .run(nowIso(), runId, stepId);
    return Number(result.changes ?? 0);
  }
}

export async function openStandaloneSqliteDurableJournal(filename: string): Promise<{
  journal: SqliteDurableJournal;
  close(): void;
}> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  return {
    journal: new SqliteDurableJournal(db),
    close: () => db.close(),
  };
}

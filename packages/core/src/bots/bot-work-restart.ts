import { nowIso } from '../id.js';
import type { SqliteStateStore } from '../storage.js';
import { latestCheckpoint } from '../session/checkpoint.js';
import { decideRecovery } from '../session/durable-recovery.js';

const EFFECT_FLAG = 'botWorkRestartEffectCheck';
const HELD_WAIT = new Set(['waiting', 'ready', 'blocked']);

type BootDisposition = 'retire' | 'hold-for-effects' | 'leave-for-wait';

export interface RestartPlan {
  retiring: Record<string, unknown>[];
  keptSessionIds: string[];
  waitSessionIds: string[];
}

export interface RestartTickHost {
  store: SqliteStateStore;
  hasUnconfirmedEffects?(sessionId: string, startedAt: string): boolean;
}

function rowsBySession(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const list = grouped.get(sessionId);
    if (list) list.push(row);
    else grouped.set(sessionId, [row]);
  }
  return grouped;
}

function heldDurableWait(store: SqliteStateStore, metadata: Record<string, unknown> | undefined): boolean {
  const waitId = metadata?.agentWaitId;
  if (typeof waitId !== 'string' || waitId.length === 0) return false;
  const table = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_waits'").get();
  if (!table) return false;
  const row = store.db.prepare('SELECT payload FROM agent_waits WHERE id=?').get(waitId) as { payload?: string } | undefined;
  if (!row?.payload) return false;
  try {
    const payload = JSON.parse(row.payload) as { status?: unknown };
    return typeof payload.status === 'string' && HELD_WAIT.has(payload.status);
  } catch {
    return false;
  }
}

function bootDisposition(store: SqliteStateStore, sessionId: string): BootDisposition {
  const session = store.getSession(sessionId);
  if (!session) return 'retire';
  if (heldDurableWait(store, session.metadata)) return 'leave-for-wait';
  const decision = decideRecovery({
    checkpoint: latestCheckpoint(session.metadata),
    messages: store.foldMessages(sessionId),
    hasUnconfirmedEffects: false,
  });
  return decision.resume ? 'hold-for-effects' : 'retire';
}

function releaseDeadWriter(store: SqliteStateStore, sessionId: string): void {
  const writer = store.getSession(sessionId)?.activeWriterRunId;
  if (writer) store.releaseWriter(sessionId, writer);
}

function markEffectCheck(store: SqliteStateStore, sessionId: string): void {
  const session = store.getSession(sessionId);
  if (!session || session.metadata[EFFECT_FLAG] === true) return;
  store.updateSession(sessionId, { metadata: { ...session.metadata, [EFFECT_FLAG]: true } });
}

export function withholdRestartSessions(store: SqliteStateStore, interrupted: Record<string, unknown>[]): RestartPlan {
  const retiring: Record<string, unknown>[] = [];
  const keptSessionIds: string[] = [];
  const waitSessionIds: string[] = [];
  for (const [sessionId, rows] of rowsBySession(interrupted)) {
    const disposition = bootDisposition(store, sessionId);
    if (disposition === 'retire') {
      retiring.push(...rows);
      continue;
    }
    releaseDeadWriter(store, sessionId);
    keptSessionIds.push(sessionId);
    if (disposition === 'leave-for-wait') {
      waitSessionIds.push(sessionId);
      continue;
    }
    markEffectCheck(store, sessionId);
  }
  return { retiring, keptSessionIds, waitSessionIds };
}

export function botWorkRestartDefersCompletion(store: SqliteStateStore, sessionId: string): boolean {
  const session = store.getSession(sessionId);
  if (!session) return false;
  if (session.metadata[EFFECT_FLAG] === true) return true;
  return heldDurableWait(store, session.metadata);
}

function earliestUpdate(rows: Record<string, unknown>[]): string {
  let best = '';
  let bestMs = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const text = String(row.updated_at ?? '');
    const ms = Date.parse(text);
    if (Number.isFinite(ms) && ms < bestMs) {
      best = text;
      bestMs = ms;
    }
  }
  return best;
}

function requeueHeldSession(store: SqliteStateStore, sessionId: string, rows: Record<string, unknown>[]): void {
  store.transaction(() => {
    const now = nowIso();
    let moved = 0;
    for (const row of rows) {
      if (row.kind === 'task') {
        const updated = store.db.prepare("UPDATE bot_work_tasks SET status='queued', failure_reason=NULL, updated_at=? WHERE id=? AND status='running'").run(now, String(row.task_id));
        if (Number(updated.changes) !== 1) continue;
      }
      const message = store.db.prepare("UPDATE bot_work_messages SET status='pending', updated_at=? WHERE id=? AND status='processing'").run(now, String(row.id));
      if (Number(message.changes) === 1) moved += 1;
    }
    if (moved === 0) return;
    const fresh = store.getSession(sessionId);
    if (!fresh) return;
    const metadata = { ...fresh.metadata };
    delete metadata[EFFECT_FLAG];
    store.updateSession(sessionId, {
      status: fresh.status === 'running' ? 'idle' : fresh.status,
      metadata,
    });
  });
}

export function settleBotWorkRestart(host: RestartTickHost, hooks: {
  isBusy(sessionId: string): boolean;
  retireUnknown(sessionId: string, rows: Record<string, unknown>[]): void;
}): void {
  const processing = host.store.db.prepare("SELECT * FROM bot_work_messages WHERE status='processing'").all() as Record<string, unknown>[];
  for (const [sessionId, rows] of rowsBySession(processing)) {
    const session = host.store.getSession(sessionId);
    if (session?.metadata[EFFECT_FLAG] !== true) continue;
    if (hooks.isBusy(sessionId)) continue;
    const unconfirmed = !host.hasUnconfirmedEffects || host.hasUnconfirmedEffects(sessionId, earliestUpdate(rows)) === true;
    if (unconfirmed) {
      hooks.retireUnknown(sessionId, rows);
      continue;
    }
    requeueHeldSession(host.store, sessionId, rows);
  }
}

import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
import type { GoalReport, GoalWait } from '../bots/goals/types.js';
import type { RoutineRun, RoutineRunStore } from '../cron/routine-runtime.js';
import { DurableWaitStore } from './store.js';
import type { WaitCondition, WaitOwner, WaitSpec } from './types.js';

/** Owned observables park here. Cron, sleep, and history polls are not substitutes. */
export const DURABLE_WAIT_DEFAULT =
  'Durable wait (wait_for / waiting_condition) is the default way to suspend for an owned observable dependency (session, bot_task, routine_run, or a host-registered adapter). Register it and end the turn. Do not cron, sleep, or poll history for a dependency this execution already owns.';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown', 'expired', 'rejected', 'timed_out']);

export function terminalObservableCondition(source: string): WaitCondition {
  const status: WaitCondition = { op: 'in', field: 'status', values: [...TERMINAL] };
  if (source === 'session') return status;
  return { op: 'all', conditions: [status, { op: 'changed', field: 'version' }] };
}

/** A dispatch/child reference the durable sources can observe. Approval holds are not this. */
export function observableDispatchWait(wait: GoalWait | undefined): { source: string; ref: string } | undefined {
  if (!wait?.source || !wait.correlationId) return undefined;
  if (wait.source === 'durable_wait') return undefined;
  if (!['session', 'bot_task', 'routine_run'].includes(wait.source)) return undefined;
  return { source: wait.source, ref: wait.correlationId };
}

/** Remember the child a routine spawn returned, so finish can park without another model turn. */
export function noteRoutineChild(
  store: SqliteStateStore,
  sessionId: string,
  content: string,
  metadata?: Record<string, unknown>
): void {
  const session = store.getSession(sessionId);
  if (!session?.metadata.routineRunId || session.metadata.routineChildSessionId) return;
  const fromMeta = typeof metadata?.childSessionId === 'string' ? metadata.childSessionId : undefined;
  let fromContent: string | undefined;
  try {
    const parsed = JSON.parse(content) as { childSessionId?: unknown };
    if (typeof parsed.childSessionId === 'string') fromContent = parsed.childSessionId;
  } catch {
    /* prose results carry no child */
  }
  const childId = fromMeta ?? fromContent;
  if (!childId || childId === sessionId) return;
  store.updateSession(session.id, { metadata: { ...session.metadata, routineChildSessionId: childId } });
}

function markHostRegistered(store: SqliteStateStore, waitId: string): void {
  const row = store.db.prepare('SELECT payload FROM agent_waits WHERE id=?').get(waitId) as { payload?: string } | undefined;
  if (!row?.payload) return;
  const wait = JSON.parse(String(row.payload));
  wait.hostRegistered = true;
  wait.updatedAt = Date.now();
  store.db.prepare('UPDATE agent_waits SET payload=? WHERE id=?').run(JSON.stringify(wait), waitId);
}

function goalOwner(
  session: SessionRecord,
  goal: { id: string; revision: number; botId: string },
  executionId: string
): WaitOwner | undefined {
  if (session.metadata.botGoalId !== goal.id) return undefined;
  const scoped = session.metadata.botGoalScopeSessionId;
  const scopeSessionId = typeof scoped === 'string' ? scoped : session.id;
  return {
    kind: 'goal',
    id: goal.id,
    revision: goal.revision,
    executionId,
    botId: goal.botId,
    sessionId: session.id,
    scopeSessionId,
  };
}

/** Host registration for a waiting dispatch. The tool path stays available for other owned observables. */
export function parkGoalDurableWait(
  store: SqliteStateStore,
  session: SessionRecord,
  goal: { id: string; revision: number; botId: string },
  executionId: string,
  wait: GoalWait,
  summary: string
): GoalReport | undefined {
  const observable = observableDispatchWait(wait);
  const owner = goalOwner(session, goal, executionId);
  if (!observable || !owner) return undefined;
  const spec: WaitSpec = {
    source: observable.source,
    ref: observable.ref,
    condition: terminalObservableCondition(observable.source),
  };
  try {
    const record = new DurableWaitStore(store).register(owner, spec);
    markHostRegistered(store, record.id);
    const checkpoint: GoalReport = {
      kind: 'waiting',
      summary,
      wait: {
        source: 'durable_wait',
        correlationId: record.id,
        description: `${observable.source}:${observable.ref}`,
      },
    };
    const live = store.getSession(session.id) ?? session;
    store.updateSession(live.id, {
      metadata: { ...live.metadata, agentWaitId: record.id, botGoalCheckpoint: checkpoint },
    });
    return checkpoint;
  } catch {
    return undefined;
  }
}

/** A child this occurrence spawned and that is still running. Other sessions are not this wait. */
export function outstandingRoutineChildId(store: SqliteStateStore, sessionId: string, runId: string): string | undefined {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'unknown']);
  const rows = store.db
    .prepare(`SELECT id, status, metadata_json FROM sessions WHERE parent_session_id=? ORDER BY rowid DESC LIMIT 32`)
    .all(sessionId) as Array<{ id: string; status: string; metadata_json: string }>;
  for (const row of rows) {
    if (terminal.has(row.status)) continue;
    let metadata: { spawnSource?: unknown; routineRunId?: unknown } = {};
    try { metadata = JSON.parse(row.metadata_json) as typeof metadata; } catch { continue; }
    if (metadata.spawnSource !== 'subagent' && metadata.routineRunId !== runId) continue;
    return row.id;
  }
  return undefined;
}

export function parkRoutineDurableWait(
  store: SqliteStateStore,
  runs: RoutineRunStore,
  run: RoutineRun,
  session: SessionRecord,
  wait: { source: string; ref: string },
  summary: string
): boolean {
  if (!['session', 'bot_task', 'routine_run'].includes(wait.source)) return false;
  const owner: WaitOwner = {
    kind: 'routine',
    id: run.id,
    revision: run.attempt,
    sessionId: session.id,
    scopeSessionId: run.mainSessionId,
  };
  const spec: WaitSpec = {
    source: wait.source,
    ref: wait.ref,
    condition: terminalObservableCondition(wait.source),
  };
  try {
    const record = new DurableWaitStore(store).register(owner, spec);
    markHostRegistered(store, record.id);
    store.updateSession(session.id, { metadata: { ...session.metadata, agentWaitId: record.id } });
    runs.update(run.id, {
      waitId: record.id,
      waitCheckpoint: summary,
      status: 'waiting_condition',
      result: summary,
      error: undefined,
    });
    return true;
  } catch {
    return false;
  }
}

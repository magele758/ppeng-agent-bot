import type { SqliteStateStore } from '../../storage.js';
import type { SessionRecord } from '../../types.js';
import { DurableWaitStore } from '../../waits/store.js';
import { BotGoalService } from './service.js';
import { readBotFinishSettings, type BotFinishSettings } from './finish-settings.js';
import type { GoalTraceKind } from './runtime-host.js';

/** One promise to report later, and how often the runtime has checked on it. */
export interface FinishWake {
  sessionId: string;
  /** Wakes registered so far for this promise, including the pending one. */
  count: number;
  /** Absent once the wake fired; the next promise in the same chain re-arms it. */
  dueAt?: number;
  /** The human message the promise answers. A newer one makes the wake obsolete. */
  humanMessageId?: string;
  promise: string;
  reason: string;
  createdAt: number;
}

export interface FinishWakeDecision { registered: boolean; reason: string; count: number; dueAt?: number }

export interface FinishWakeHost {
  store: SqliteStateStore;
  isRunning(sessionId: string): boolean;
  run(sessionId: string): Promise<unknown>;
  emitTrace?(sessionId: string, event: { kind: GoalTraceKind; payload: Record<string, unknown> }): void;
}

const PREFIX = 'bot.finish-wake:';
const WAKE_TOOLS = new Set(['wait_for', 'cron_create']);

export function readFinishWake(store: Pick<SqliteStateStore, 'getDaemonControl'>, sessionId: string): FinishWake | undefined {
  return store.getDaemonControl<FinishWake>(PREFIX + sessionId);
}

export function clearFinishWake(store: Pick<SqliteStateStore, 'deleteDaemonControl'>, sessionId: string): void {
  store.deleteDaemonControl(PREFIX + sessionId);
}

function goalWaiting(store: SqliteStateStore, session: SessionRecord): boolean {
  const botId = session.metadata?.botId;
  if (typeof botId !== 'string') return false;
  return new BotGoalService(store, Date.now, session.id).list(botId).some(goal => goal.status === 'running' || goal.status === 'waiting');
}

/** Something already brings this chat back: a running background job, a registered wait, a timer, or an armed wake. */
export function hasDurableWake(store: SqliteStateStore, session: SessionRecord, toolNames: string[]): boolean {
  if (toolNames.some(name => WAKE_TOOLS.has(name))) return true;
  if (store.listBackgroundJobs(session.id).some(job => job.status === 'running')) return true;
  if (readFinishWake(store, session.id)?.dueAt !== undefined) return true;
  if (typeof session.metadata?.agentWaitId === 'string' && new DurableWaitStore(store).get(session.metadata.agentWaitId)?.status === 'waiting') return true;
  return goalWaiting(store, session);
}

/** Arm the next wake for this promise. Each one waits twice as long as the last; the count is capped. */
export function registerFinishWake(
  store: SqliteStateStore,
  sessionId: string,
  input: { settings: BotFinishSettings; humanMessageId?: string; promise: string; reason: string; now?: number }
): FinishWakeDecision {
  const now = input.now ?? Date.now();
  const prior = readFinishWake(store, sessionId);
  const sameChain = prior && prior.humanMessageId === input.humanMessageId;
  const used = sameChain ? prior.count : 0;
  if (used >= input.settings.maxWakes) {
    clearFinishWake(store, sessionId);
    return { registered: false, reason: 'wake_cap', count: used };
  }
  const dueAt = now + input.settings.wakeDelayMinutes * 60_000 * 2 ** used;
  const wake: FinishWake = { sessionId, count: used + 1, dueAt, humanMessageId: input.humanMessageId, promise: input.promise, reason: input.reason, createdAt: now };
  store.setDaemonControl(PREFIX + sessionId, wake);
  return { registered: true, reason: 'registered', count: wake.count, dueAt };
}

function lastHumanMessageId(store: SqliteStateStore, sessionId: string): string | undefined {
  return store.foldMessages(sessionId).findLast(message => message.role === 'user' && !message.key)?.id;
}

function busy(host: FinishWakeHost, session: SessionRecord): boolean {
  if (host.isRunning(session.id) || session.status !== 'idle' || session.activeWriterRunId) return true;
  return Boolean(host.store.db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND status='pending' LIMIT 1").get(session.id));
}

function wakeMessage(wake: FinishWake, maxWakes: number): string {
  const left = Math.max(0, maxWakes - wake.count);
  return `[follow-up wake ${wake.count}/${maxWakes}] Earlier you told the user you would report back: "${wake.promise.slice(-400)}"\nCheck the real status now with your tools. If it finished, report the result briefly. If it failed, say so and fix it if you can. If it is still running, reply with one short line and nothing else; ${left > 0 ? `the runtime will wake you again (${left} more).` : 'this is the last automatic check, so tell the user how to ask for the result later.'}`;
}

function fire(host: FinishWakeHost, wake: FinishWake, maxWakes: number): void {
  host.store.setDaemonControl(PREFIX + wake.sessionId, { ...wake, dueAt: undefined });
  host.store.enqueueSteer(wake.sessionId, wakeMessage(wake, maxWakes), { role: 'system', key: `finish-wake:${wake.sessionId}:${wake.createdAt}` });
  host.emitTrace?.(wake.sessionId, { kind: 'finish_wake', payload: { event: 'fired', count: wake.count, maxWakes, reason: wake.reason } });
  void host.run(wake.sessionId).catch(() => undefined);
}

function tickWake(host: FinishWakeHost, wake: FinishWake, now: number, maxWakes: number): void {
  if (wake.dueAt === undefined || wake.dueAt > now) return;
  const session = host.store.getSession(wake.sessionId);
  if (!session) { clearFinishWake(host.store, wake.sessionId); return; }
  if (lastHumanMessageId(host.store, wake.sessionId) !== wake.humanMessageId) {
    clearFinishWake(host.store, wake.sessionId);
    host.emitTrace?.(wake.sessionId, { kind: 'finish_wake', payload: { event: 'obsolete', count: wake.count, reason: 'newer_user_message' } });
    return;
  }
  // A busy chat is checked again on the next tick.
  if (busy(host, session)) return;
  fire(host, wake, maxWakes);
}

/** Scheduler entry: fire wakes that are due. Dispatch only; the woken run is not awaited. */
export function tickFinishWakes(host: FinishWakeHost, now = Date.now()): void {
  const settings = readBotFinishSettings(host.store);
  if (!settings.wakeEnabled) return;
  const rows = host.store.db.prepare('SELECT value_json FROM daemon_control WHERE key LIKE ?').all(`${PREFIX}%`) as Array<{ value_json: string }>;
  for (const row of rows) {
    let wake: FinishWake;
    try { wake = JSON.parse(row.value_json) as FinishWake; } catch { continue; }
    if (typeof wake?.sessionId !== 'string') continue;
    tickWake(host, wake, now, settings.maxWakes);
  }
}

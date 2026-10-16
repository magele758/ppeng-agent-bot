/**
 * Read model for the Lab activity rail.
 * Projects existing bot routine runs and background jobs / conversations.
 * Does not create a second task ledger.
 */
import type { RoutineRun } from '../cron/routine-runtime.js';
import type { SqliteStateStore } from '../storage.js';
import type { BackgroundJobRecord, SessionRecord } from '../types.js';

export type BotActivityStatus = 'running' | 'waiting' | 'done';
export type BotActivityKind = 'routine' | 'background';

export interface BotActivityItem {
  id: string;
  kind: BotActivityKind;
  title: string;
  status: BotActivityStatus;
  botId: string;
  botName: string;
  startedAt: string;
}

const DONE_WINDOW_MS = 30 * 60 * 1000;
const DONE_CAP = 20;
const TITLE_MAX = 160;

const DONE_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'silent',
  'error'
]);

export function botActivityStatus(raw: string): BotActivityStatus {
  if (raw === 'running') return 'running';
  if (DONE_STATUSES.has(raw)) return 'done';
  return 'waiting';
}

function textMeta(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sameOwner(focus: SessionRecord, session: SessionRecord): boolean {
  const fu = textMeta(focus.metadata, 'userId');
  const su = textMeta(session.metadata, 'userId');
  const ft = textMeta(focus.metadata, 'tenantId');
  const st = textMeta(session.metadata, 'tenantId');
  // Both sides have an explicit userId: require exact match.
  // If either side has no userId (legacy/single-user), fall back to tenantId match.
  // Two sessions both missing userId AND tenantId are treated as same-owner (single-user local mode).
  if (fu && su) return fu === su && ft === st;
  if (ft && st) return ft === st;
  // ponytail: both unowned = same-owner in local mode; hiddenFromOwner guards multi-user with real userIds
  return !fu && !su && !ft && !st;
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX) return flat;
  return `${flat.slice(0, TITLE_MAX - 1)}…`;
}

function botLabel(botId: string, names: ReadonlyMap<string, string>, fallback: string): string {
  const named = botId ? names.get(botId) : undefined;
  if (named) return named;
  return botId || fallback;
}

function isRecent(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age <= DONE_WINDOW_MS && age >= -60_000;
}

function keepRow(status: BotActivityStatus, stamp: string | undefined, now: number): boolean {
  if (status !== 'done') return true;
  return isRecent(stamp, now);
}

function rank(status: BotActivityStatus): number {
  switch (status) {
    case 'running':
      return 0;
    case 'waiting':
      return 1;
    case 'done':
      return 2;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export interface AssembleBotActivityInput {
  focus: SessionRecord;
  sessions: readonly SessionRecord[];
  jobs: readonly BackgroundJobRecord[];
  routines: readonly RoutineRun[];
  botNames: ReadonlyMap<string, string>;
  now?: number;
}

function indexSessions(sessions: readonly SessionRecord[], focus: SessionRecord): Map<string, SessionRecord> {
  const byId = new Map<string, SessionRecord>();
  for (const session of sessions) byId.set(session.id, session);
  byId.set(focus.id, focus);
  return byId;
}

function routineTied(run: RoutineRun, focus: SessionRecord, byId: Map<string, SessionRecord>): boolean {
  if (run.mainSessionId === focus.id || run.job.sessionId === focus.id) return true;
  const main = byId.get(run.mainSessionId);
  const focusBot = textMeta(focus.metadata, 'botId');
  const jobBot = textMeta(run.job.metadata, 'botId');
  if (!focusBot || jobBot !== focusBot || !main) return false;
  return sameOwner(focus, main);
}

function hiddenFromOwner(run: RoutineRun, focus: SessionRecord, byId: Map<string, SessionRecord>): boolean {
  const main = byId.get(run.mainSessionId);
  if (!main || run.mainSessionId === focus.id) return false;
  return !sameOwner(focus, main);
}

function routineItem(
  run: RoutineRun,
  focus: SessionRecord,
  byId: Map<string, SessionRecord>,
  names: ReadonlyMap<string, string>,
  now: number
): BotActivityItem | undefined {
  if (!routineTied(run, focus, byId) || hiddenFromOwner(run, focus, byId)) return undefined;
  const status = botActivityStatus(run.status);
  const stamp = run.finishedAt || run.updatedAt;
  if (!keepRow(status, stamp, now)) return undefined;
  const botId = textMeta(run.job.metadata, 'botId') || textMeta(focus.metadata, 'botId');
  const title = run.job.name || run.job.prompt || run.id;
  return {
    id: `routine:${run.id}`,
    kind: 'routine',
    title: clip(title),
    status,
    botId,
    botName: botLabel(botId, names, focus.agentId),
    startedAt: run.startedAt || run.createdAt
  };
}

function isRelatedSession(session: SessionRecord, focus: SessionRecord): boolean {
  if (session.parentSessionId === focus.id) return true;
  const focusBot = textMeta(focus.metadata, 'botId');
  const botId = textMeta(session.metadata, 'botId');
  if (!focusBot || botId !== focusBot || !sameOwner(focus, session)) return false;
  if (session.metadata.canonicalBotChat === true) return false;
  return session.background || session.mode === 'teammate' || session.mode === 'subagent';
}

function sessionItem(
  session: SessionRecord,
  focus: SessionRecord,
  names: ReadonlyMap<string, string>,
  now: number
): BotActivityItem | undefined {
  if (textMeta(session.metadata, 'routineRunId')) return undefined;
  if (session.status === 'idle') return undefined;
  const status = botActivityStatus(session.status);
  if (!keepRow(status, session.updatedAt, now)) return undefined;
  const botId = textMeta(session.metadata, 'botId') || textMeta(focus.metadata, 'botId');
  return {
    id: `session:${session.id}`,
    kind: 'background',
    title: clip(session.title || session.id),
    status,
    botId,
    botName: botLabel(botId, names, session.agentId),
    startedAt: session.createdAt
  };
}

function jobItem(
  job: BackgroundJobRecord,
  focus: SessionRecord,
  byId: Map<string, SessionRecord>,
  names: ReadonlyMap<string, string>,
  now: number
): BotActivityItem | undefined {
  const status = botActivityStatus(job.status);
  if (!keepRow(status, job.updatedAt, now)) return undefined;
  const session = byId.get(job.sessionId);
  const botId = textMeta(session?.metadata, 'botId') || textMeta(focus.metadata, 'botId');
  const fallback = session?.agentId ?? focus.agentId;
  return {
    id: `job:${job.id}`,
    kind: 'background',
    title: clip(job.command || job.id),
    status,
    botId,
    botName: botLabel(botId, names, fallback),
    startedAt: job.createdAt
  };
}

function collectRoutines(
  items: BotActivityItem[],
  routineSessionIds: Set<string>,
  input: AssembleBotActivityInput,
  byId: Map<string, SessionRecord>,
  now: number
): void {
  for (const run of input.routines) {
    const item = routineItem(run, input.focus, byId, input.botNames, now);
    if (!item) continue;
    items.push(item);
    if (run.sessionId) routineSessionIds.add(run.sessionId);
  }
}

function collectSessions(
  items: BotActivityItem[],
  routineSessionIds: Set<string>,
  input: AssembleBotActivityInput,
  now: number
): Set<string> {
  const relatedIds = new Set<string>([input.focus.id]);
  for (const session of input.sessions) {
    if (session.id === input.focus.id) continue;
    if (routineSessionIds.has(session.id)) {
      relatedIds.add(session.id);
      continue;
    }
    if (!isRelatedSession(session, input.focus)) continue;
    relatedIds.add(session.id);
    const item = sessionItem(session, input.focus, input.botNames, now);
    if (!item) continue;
    items.push(item);
  }
  return relatedIds;
}

function collectJobs(
  items: BotActivityItem[],
  relatedIds: Set<string>,
  input: AssembleBotActivityInput,
  byId: Map<string, SessionRecord>,
  now: number
): void {
  for (const job of input.jobs) {
    if (!relatedIds.has(job.sessionId)) continue;
    const item = jobItem(job, input.focus, byId, input.botNames, now);
    if (!item) continue;
    items.push(item);
  }
}

function capAndSort(items: BotActivityItem[]): BotActivityItem[] {
  const active = items.filter((item) => item.status !== 'done');
  const done = items
    .filter((item) => item.status === 'done')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
    .slice(0, DONE_CAP);
  return [...active, ...done].sort((a, b) => compareItems(a, b));
}

function compareItems(a: BotActivityItem, b: BotActivityItem): number {
  const byStatus = rank(a.status) - rank(b.status);
  if (byStatus !== 0) return byStatus;
  const byTime = b.startedAt.localeCompare(a.startedAt);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

/** Pure projection. In-flight rows stay; finished rows stay for a short window. */
export function assembleBotActivity(input: AssembleBotActivityInput): BotActivityItem[] {
  const now = input.now ?? Date.now();
  const byId = indexSessions(input.sessions, input.focus);
  const routineSessionIds = new Set<string>();
  const items: BotActivityItem[] = [];
  collectRoutines(items, routineSessionIds, input, byId, now);
  const relatedIds = collectSessions(items, routineSessionIds, input, now);
  collectJobs(items, relatedIds, input, byId, now);
  return capAndSort(items);
}

function parseRun(payload: string): RoutineRun | undefined {
  try {
    const run = JSON.parse(payload) as RoutineRun;
    if (!run?.id || !run.job) return undefined;
    return run;
  } catch {
    return undefined;
  }
}

function parseRuns(rows: Array<{ payload: string }>): RoutineRun[] {
  const seen = new Set<string>();
  const runs: RoutineRun[] = [];
  for (const row of rows) {
    const run = parseRun(String(row.payload));
    if (!run || seen.has(run.id)) continue;
    seen.add(run.id);
    runs.push(run);
  }
  return runs;
}

function loadRoutines(store: SqliteStateStore): RoutineRun[] {
  const table = store.db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='bot_routine_runs'")
    .get();
  if (!table) return [];
  const active = store.db
    .prepare(
      "SELECT payload FROM bot_routine_runs WHERE status IN ('queued','running','waiting_approval','unknown')"
    )
    .all() as Array<{ payload: string }>;
  const recent = store.db
    .prepare(
      "SELECT payload FROM bot_routine_runs WHERE status NOT IN ('queued','running','waiting_approval','unknown') ORDER BY rowid DESC LIMIT 200"
    )
    .all() as Array<{ payload: string }>;
  return parseRuns([...active, ...recent]);
}

/** Read-only snapshot for one open session. */
export function listSessionBotActivity(
  store: SqliteStateStore,
  focus: SessionRecord,
  now = Date.now()
): BotActivityItem[] {
  const names = new Map<string, string>();
  for (const bot of store.listBots({ includeHidden: true })) names.set(bot.id, bot.name);
  return assembleBotActivity({
    focus,
    sessions: store.listSessions(),
    jobs: store.listBackgroundJobs(),
    routines: loadRoutines(store),
    botNames: names,
    now
  });
}

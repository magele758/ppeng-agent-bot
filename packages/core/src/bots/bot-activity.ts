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
  return (
    textMeta(focus.metadata, 'userId') === textMeta(session.metadata, 'userId') &&
    textMeta(focus.metadata, 'tenantId') === textMeta(session.metadata, 'tenantId')
  );
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

/** Pure projection. In-flight rows stay; finished rows stay for a short window. */
export function assembleBotActivity(input: AssembleBotActivityInput): BotActivityItem[] {
  const now = input.now ?? Date.now();
  const focusBot = textMeta(input.focus.metadata, 'botId');
  const byId = new Map<string, SessionRecord>();
  for (const session of input.sessions) byId.set(session.id, session);
  byId.set(input.focus.id, input.focus);

  const routineSessionIds = new Set<string>();
  const items: BotActivityItem[] = [];

  for (const run of input.routines) {
    const main = byId.get(run.mainSessionId);
    const jobBot = textMeta(run.job.metadata, 'botId');
    const sameBot =
      Boolean(focusBot) && jobBot === focusBot && Boolean(main) && sameOwner(input.focus, main!);
    const tied =
      run.mainSessionId === input.focus.id || run.job.sessionId === input.focus.id || sameBot;
    if (!tied) continue;
    if (main && run.mainSessionId !== input.focus.id && !sameOwner(input.focus, main)) continue;
    const status = botActivityStatus(run.status);
    if (status === 'done' && !isRecent(run.finishedAt || run.updatedAt, now)) continue;
    if (run.sessionId) routineSessionIds.add(run.sessionId);
    const botId = jobBot || focusBot;
    items.push({
      id: `routine:${run.id}`,
      kind: 'routine',
      title: clip(run.job.name || run.job.prompt || run.id),
      status,
      botId,
      botName: botLabel(botId, input.botNames, input.focus.agentId),
      startedAt: run.startedAt || run.createdAt
    });
  }

  const relatedIds = new Set<string>([input.focus.id]);
  for (const session of input.sessions) {
    if (session.id === input.focus.id) continue;
    if (routineSessionIds.has(session.id)) {
      relatedIds.add(session.id);
      continue;
    }
    const child = session.parentSessionId === input.focus.id;
    const botId = textMeta(session.metadata, 'botId');
    const sibling =
      Boolean(focusBot) &&
      botId === focusBot &&
      sameOwner(input.focus, session) &&
      session.metadata.canonicalBotChat !== true &&
      (session.background || session.mode === 'teammate' || session.mode === 'subagent');
    if (!child && !sibling) continue;
    relatedIds.add(session.id);
    if (textMeta(session.metadata, 'routineRunId')) continue;
    if (session.status === 'idle') continue;
    const status = botActivityStatus(session.status);
    if (status === 'done' && !isRecent(session.updatedAt, now)) continue;
    const rowBot = botId || focusBot;
    items.push({
      id: `session:${session.id}`,
      kind: 'background',
      title: clip(session.title || session.id),
      status,
      botId: rowBot,
      botName: botLabel(rowBot, input.botNames, session.agentId),
      startedAt: session.createdAt
    });
  }

  for (const job of input.jobs) {
    if (!relatedIds.has(job.sessionId)) continue;
    const status = botActivityStatus(job.status);
    if (status === 'done' && !isRecent(job.updatedAt, now)) continue;
    const session = byId.get(job.sessionId);
    const botId = (session ? textMeta(session.metadata, 'botId') : '') || focusBot;
    items.push({
      id: `job:${job.id}`,
      kind: 'background',
      title: clip(job.command || job.id),
      status,
      botId,
      botName: botLabel(botId, input.botNames, session?.agentId ?? input.focus.agentId),
      startedAt: job.createdAt
    });
  }

  const active = items.filter((item) => item.status !== 'done');
  const done = items
    .filter((item) => item.status === 'done')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
    .slice(0, DONE_CAP);
  return [...active, ...done].sort(
    (a, b) => rank(a.status) - rank(b.status) || b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id)
  );
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
  const seen = new Set<string>();
  const runs: RoutineRun[] = [];
  for (const row of [...active, ...recent]) {
    try {
      const run = JSON.parse(String(row.payload)) as RoutineRun;
      if (!run?.id || !run.job || seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    } catch {
      /* Skip a corrupt payload; the ledger row stays untouched. */
    }
  }
  return runs;
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

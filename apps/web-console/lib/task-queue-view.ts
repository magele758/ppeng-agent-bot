import { formatRelativeTime, type BotNameLookup, type RelativeTimeLabels } from './bot-tasks-view.ts';
import type { BotInfo, TaskSummary } from './types.ts';

export type QueuePriorityBand = 'attention' | 'active' | 'pending' | 'done';
export type QueueScope = 'all' | 'tasks' | 'schedules' | 'jobs';
export type ScheduleAction = 'approve' | 'reject' | 'run_now' | 'cancel';

export type QueueSelection =
  | { kind: 'task'; id: string; index?: number }
  | { kind: 'schedule'; id: string }
  | { kind: 'job'; id: string; index?: number };

export interface TaskEventRecord {
  id: string;
  taskId: string;
  kind: string;
  actor: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskDetailPayload {
  task: TaskSummary;
  events: TaskEventRecord[];
  session?: {
    id: string;
    title?: string;
    status?: string;
    agentId?: string;
  };
}

export interface QueueEventSummary {
  title: string;
  detail: string;
  time: string;
}

export type QueueEventTitleKey =
  | 'tasks.queue.eventTypes.taskCreated'
  | 'tasks.queue.eventTypes.taskUpdated'
  | 'tasks.queue.eventTypes.taskStarted'
  | 'tasks.queue.eventTypes.taskCompleted'
  | 'tasks.queue.eventTypes.taskFailed'
  | 'tasks.queue.eventTypes.taskCancelled'
  | 'tasks.queue.eventTypes.taskBlocked';

export interface QueueEventFormatOptions {
  nowMs?: number;
  resolveTitle?: (kind: string, i18nKey: QueueEventTitleKey | undefined) => string;
  relativeLabels?: RelativeTimeLabels;
}

export const QUEUE_BAND_ORDER: readonly QueuePriorityBand[] = [
  'attention',
  'active',
  'pending',
  'done',
];

const STATUS_TO_BAND: Readonly<Record<string, QueuePriorityBand>> = {
  failed: 'attention',
  blocked: 'attention',
  error: 'attention',
  in_progress: 'active',
  running: 'active',
  waiting_approval: 'active',
  pending: 'pending',
  queued: 'pending',
  completed: 'done',
  cancelled: 'done',
};

const SCHEDULE_ACTIONS_BY_STATUS: Readonly<Record<string, readonly ScheduleAction[]>> = {
  pending: ['approve', 'reject', 'run_now', 'cancel'],
  in_progress: ['cancel'],
  failed: ['run_now', 'cancel'],
  completed: [],
  cancelled: [],
};

export const QUEUE_EVENT_KEY_MAP: Readonly<Record<string, QueueEventTitleKey>> = {
  'task.created': 'tasks.queue.eventTypes.taskCreated',
  'task.updated': 'tasks.queue.eventTypes.taskUpdated',
  'task.started': 'tasks.queue.eventTypes.taskStarted',
  'task.completed': 'tasks.queue.eventTypes.taskCompleted',
  'task.failed': 'tasks.queue.eventTypes.taskFailed',
  'task.cancelled': 'tasks.queue.eventTypes.taskCancelled',
  'task.blocked': 'tasks.queue.eventTypes.taskBlocked',
};

const SETUP_SEGMENT_RE = /^(?:cd\s+|export\s+|set\s+-[a-z]+|mkdir\s+|umask\s+)/i;
const LEADING_SETUP_RE = /^(?:cd\s+|export\s+|set\s+-[a-z]+|mkdir\s+|umask\s+)[^&;]+(?:&&|;)\s*/i;
const SHELL_REDIRECT_RE = /\s+(?:2>&1|1>&2|&>>?\s*\S+|\d?>>?\s*\S+|\|\s*tee\b[\s\S]*)$/i;
const LONG_PATH_RE = /(?:~|\/)[^\s"'`]{16,}/g;
const SSH_PREFIX_RE = /^ssh\s+/i;
const SSH_OPT_RE = /^(?:-(?:[opbceliFmJLRSWE]\s+(?:'[^']*'|"[^"]*"|\S+)|o\S+|[1246AaCfGgKkMNnqsTtVvXxYy]+))\s+/;
const INLINE_JSON_LABEL_RE = /\b(?:Policy|Config|Metadata|Options|Payload)\s*:\s*\{[\s\S]*$/i;
const MAX_JOB_TITLE_CHARS = 80;

export function buildBotNameMap(
  bots: ReadonlyArray<Pick<BotInfo, 'id' | 'name'>>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const bot of bots) {
    if (bot.name.trim()) map.set(bot.id, bot.name.trim());
  }
  return map;
}

export function resolveAgentLabel(
  ownerAgentId: string | undefined,
  bots: ReadonlyArray<Pick<BotInfo, 'id' | 'name'>>,
  unassignedLabel: string
): string {
  const raw = ownerAgentId?.trim() ?? '';
  if (!raw) return unassignedLabel;
  const bot = bots.find((item) => item.id === raw);
  return bot?.name.trim() || raw;
}

function pickPrimaryCommandSegment(command: string): string {
  const parts = command
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const meaningful = parts.find((part) => !SETUP_SEGMENT_RE.test(part));
  return meaningful ?? parts[parts.length - 1] ?? '';
}

function stripTrailingRedirects(segment: string): string {
  let current = segment.trim();
  for (let pass = 0; pass < 3; pass++) {
    const next = current.replace(SHELL_REDIRECT_RE, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function shortenPathToken(token: string): string {
  const parts = token.split('/').filter(Boolean);
  if (parts.length < 3) return token;
  return `…/${parts[parts.length - 1]}`;
}

function clipJobTitle(text: string): string {
  if (text.length <= MAX_JOB_TITLE_CHARS) return text;
  return `${text.slice(0, MAX_JOB_TITLE_CHARS - 1).trimEnd()}…`;
}

function stripSshFlags(rest: string): string {
  let current = rest.trim();
  for (let pass = 0; pass < 16; pass++) {
    const next = current.replace(SSH_OPT_RE, '');
    if (next === current) break;
    current = next;
  }
  return current;
}

function unquoteEdge(text: string): string {
  return text.replace(/^['"]/, '').replace(/['"]$/, '').trim();
}

function distillSegment(segment: string): string {
  const primary = stripTrailingRedirects(pickPrimaryCommandSegment(segment));
  return (primary || segment).replace(LONG_PATH_RE, shortenPathToken);
}

function formatSshSummary(host: string, rawRemote: string | undefined): string {
  const remote = rawRemote ? distillSegment(unquoteEdge(rawRemote)) : '';
  return remote ? `ssh ${host} · ${remote}` : `ssh ${host}`;
}

function summarizeSshCommand(command: string): string | null {
  if (!SSH_PREFIX_RE.test(command)) return null;
  const afterFlags = stripSshFlags(command.replace(SSH_PREFIX_RE, ''));
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(afterFlags);
  return match ? formatSshSummary(match[1], match[2]) : null;
}

function stripLeadingSetup(command: string): string {
  let current = command.trim();
  for (let pass = 0; pass < 6; pass++) {
    const next = current.replace(LEADING_SETUP_RE, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizeCommandText(command: string | undefined): string {
  return (command ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Distills verbose shell pipelines and SSH flag chains into a concise scannable title
 * while leaving the raw command intact for the detail pane.
 */
export function extractJobDisplayTitle(command: string | undefined, fallback: string): string {
  const clean = stripLeadingSetup(normalizeCommandText(command));
  if (!clean) return fallback;
  const compact = summarizeSshCommand(clean) ?? distillSegment(clean);
  return clipJobTitle(compact) || fallback;
}

function cleanQueuePreviewLine(line: string): string {
  const stripped = line.replace(INLINE_JSON_LABEL_RE, '').trim();
  if (!stripped || stripped.startsWith('{')) return '';
  return stripped;
}

/**
 * Extracts the first human-readable preview line from a queue task description,
 * stripping inline `Policy: {...}` / `Config: {...}` JSON blobs.
 */
export function extractQueueTaskPreview(description: string | undefined): string {
  if (!description) return '';
  for (const raw of description.split(/\r?\n/)) {
    const cleaned = cleanQueuePreviewLine(raw.trim());
    if (cleaned) return cleaned;
  }
  return '';
}

export function classifyQueueBand(status: string): QueuePriorityBand {
  return STATUS_TO_BAND[status] ?? 'done';
}

export function groupQueueTasks<T extends { status: string }>(
  tasks: readonly T[]
): Record<QueuePriorityBand, T[]> {
  const groups: Record<QueuePriorityBand, T[]> = {
    attention: [],
    active: [],
    pending: [],
    done: [],
  };
  for (const task of tasks) {
    groups[classifyQueueBand(task.status)].push(task);
  }
  return groups;
}

function lookupName(map: BotNameLookup, id: string | undefined): string {
  if (!id) return '';
  if (map instanceof Map) return map.get(id) ?? '';
  return (map as Readonly<Record<string, string>>)[id] ?? '';
}

export function matchesQueueQuery(
  task: Pick<TaskSummary, 'title' | 'description' | 'ownerAgentId'>,
  query: string,
  botNameMap: BotNameLookup
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const resolved = lookupName(botNameMap, task.ownerAgentId);
  const fields = [task.title, task.description, task.ownerAgentId, resolved];
  return fields.some((part) => typeof part === 'string' && part.toLowerCase().includes(needle));
}

function summarizePayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  for (const key of ['reason', 'error', 'status', 'title', 'message']) {
    const val = payload[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

export function queueEventTitleKey(kind: string): QueueEventTitleKey | undefined {
  return QUEUE_EVENT_KEY_MAP[kind];
}

export function formatQueueEventSummary(
  event: TaskEventRecord,
  locale: 'zh' | 'en' | string = 'zh',
  options: QueueEventFormatOptions = {}
): QueueEventSummary {
  const i18nKey = queueEventTitleKey(event.kind);
  const title = options.resolveTitle ? options.resolveTitle(event.kind, i18nKey) : event.kind;
  const payloadText = summarizePayload(event.payload);
  const detailParts = [event.actor, payloadText].filter(Boolean);
  return {
    title,
    detail: detailParts.join(' · '),
    time: formatRelativeTime(event.createdAt, locale, options.nowMs, options.relativeLabels),
  };
}

export function getScheduleActions(status: string): ScheduleAction[] {
  return [...(SCHEDULE_ACTIONS_BY_STATUS[status] ?? [])];
}

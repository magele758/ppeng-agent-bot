import { formatRelativeTime, type BotNameLookup } from './bot-tasks-view.ts';
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

const EVENT_TITLES_ZH: Readonly<Record<string, string>> = {
  'task.created': '任务已创建',
  'task.updated': '状态已更新',
  'task.started': '开始执行',
  'task.completed': '执行完成',
  'task.failed': '执行失败',
  'task.cancelled': '任务已取消',
  'task.blocked': '任务受阻',
};

const EVENT_TITLES_EN: Readonly<Record<string, string>> = {
  'task.created': 'Task created',
  'task.updated': 'Status updated',
  'task.started': 'Execution started',
  'task.completed': 'Completed',
  'task.failed': 'Failed',
  'task.cancelled': 'Cancelled',
  'task.blocked': 'Blocked',
};

const SETUP_SEGMENT_RE = /^(?:cd\s+|export\s+|set\s+-[a-z]+|mkdir\s+|umask\s+)/i;
const SHELL_REDIRECT_RE = /\s+(?:2>&1|1>&2|&>>?\s*\S+|\d?>>?\s*\S+|\|\s*tee\b[\s\S]*)$/i;
const LONG_PATH_RE = /(?:~|\/)[^\s"'`]{16,}/g;
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

/**
 * Distills verbose shell pipelines (e.g. `cd /path && tool --flag /a/b/c > /tmp/log 2>&1`)
 * into a concise scannable title while leaving the raw command intact for the detail pane.
 */
export function extractJobDisplayTitle(command: string | undefined, fallback: string): string {
  const clean = (command ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  const primary = stripTrailingRedirects(pickPrimaryCommandSegment(clean));
  const compact = (primary || clean).replace(LONG_PATH_RE, shortenPathToken);
  return clipJobTitle(compact) || fallback;
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

export function formatQueueEventSummary(
  event: TaskEventRecord,
  locale: 'zh' | 'en' | string = 'zh',
  nowMs?: number
): QueueEventSummary {
  const isEn = locale.toLowerCase().startsWith('en');
  const titleMap = isEn ? EVENT_TITLES_EN : EVENT_TITLES_ZH;
  const title = titleMap[event.kind] ?? event.kind;
  const payloadText = summarizePayload(event.payload);
  const detailParts = [event.actor, payloadText].filter(Boolean);
  return {
    title,
    detail: detailParts.join(' · '),
    time: formatRelativeTime(event.createdAt, locale, nowMs),
  };
}

export function getScheduleActions(status: string): ScheduleAction[] {
  return [...(SCHEDULE_ACTIONS_BY_STATUS[status] ?? [])];
}

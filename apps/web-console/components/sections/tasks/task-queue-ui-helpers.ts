import type { MessageKey } from '@/lib/i18n';
import {
  QUEUE_BAND_ORDER,
  extractJobDisplayTitle,
  groupQueueTasks,
  type QueuePriorityBand,
  type QueueScope,
  type ScheduleAction
} from '@/lib/task-queue-view';
import type { SocialPostScheduleItem, TaskSummary } from '@/lib/types';
import type { JobRow } from '../../shell/LabProvider';

export type StatusTone = 'danger' | 'active' | 'warn' | 'ok' | 'neutral';

export interface IndexedTask {
  key: string;
  index: number;
  task: TaskSummary;
}

export interface IndexedJob {
  key: string;
  index: number;
  job: JobRow;
}

export type ResolvedQueueItem =
  | { kind: 'task'; key: string; task: TaskSummary }
  | { kind: 'schedule'; key: string; schedule: SocialPostScheduleItem }
  | { kind: 'job'; key: string; job: JobRow };

const STATUS_TONE_MAP: Readonly<Record<string, StatusTone>> = {
  failed: 'danger',
  blocked: 'danger',
  error: 'danger',
  in_progress: 'active',
  running: 'active',
  waiting_approval: 'active',
  pending: 'warn',
  queued: 'warn',
  completed: 'ok',
  cancelled: 'neutral'
};

const STATUS_LABEL_KEY_MAP: Readonly<Record<string, MessageKey>> = {
  all: 'tasks.status.all',
  pending: 'tasks.status.pending',
  queued: 'tasks.status.pending',
  in_progress: 'tasks.status.in_progress',
  completed: 'tasks.status.completed',
  failed: 'tasks.status.failed',
  error: 'tasks.status.failed',
  cancelled: 'tasks.status.cancelled',
  running: 'tasks.runStatus.running',
  waiting_approval: 'tasks.runStatus.waiting_approval',
  blocked: 'tasks.runStatus.blocked'
};

export const BAND_LABEL_KEYS: Readonly<Record<QueuePriorityBand, MessageKey>> = {
  attention: 'tasks.queue.bandAttention',
  active: 'tasks.queue.bandActive',
  pending: 'tasks.queue.bandPending',
  done: 'tasks.queue.bandDone'
};

export const SCHEDULE_ACTION_META: Readonly<
  Record<ScheduleAction, { labelKey: MessageKey; tone: 'primary' | 'danger' | 'neutral' }>
> = {
  approve: { labelKey: 'tasks.queue.actionApprove', tone: 'primary' },
  run_now: { labelKey: 'tasks.queue.actionRunNow', tone: 'primary' },
  reject: { labelKey: 'tasks.queue.actionReject', tone: 'danger' },
  cancel: { labelKey: 'tasks.queue.actionCancel', tone: 'neutral' }
};

export function statusToneOf(status: string | undefined): StatusTone {
  return (status && STATUS_TONE_MAP[status]) || 'neutral';
}

export function statusLabelKeyOf(status: string | undefined): MessageKey | null {
  return (status && STATUS_LABEL_KEY_MAP[status]) || null;
}

export function taskRowKey(task: TaskSummary, index: number): string {
  return `task:${task.id ? task.id : `idx-${index}`}`;
}

export function scheduleRowKey(schedule: SocialPostScheduleItem): string {
  return `schedule:${schedule.taskId}`;
}

export function jobRowKey(job: JobRow, index: number): string {
  return `job:${job.id ? job.id : `idx-${index}`}`;
}

export function matchesScheduleQuery(item: SocialPostScheduleItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [item.title, item.taskId, item.status, ...item.channels].join(' ').toLowerCase();
  return hay.includes(needle);
}

export function matchesJobQuery(job: JobRow, query: string, fallback: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const title = extractJobDisplayTitle(job.command, fallback);
  const hay = [title, job.command ?? '', job.status ?? '', job.id ?? ''].join(' ').toLowerCase();
  return hay.includes(needle);
}

export function firstLineSnippet(text: string | undefined): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0);
  return line ? line.trim() : '';
}

export function groupIndexedTasks(items: readonly IndexedTask[]): Record<QueuePriorityBand, IndexedTask[]> {
  const flat = items.map((entry) => ({ status: entry.task.status, entry }));
  const grouped = groupQueueTasks(flat);
  return {
    attention: grouped.attention.map((x) => x.entry),
    active: grouped.active.map((x) => x.entry),
    pending: grouped.pending.map((x) => x.entry),
    done: grouped.done.map((x) => x.entry)
  };
}

function collectTaskItems(grouped: Record<QueuePriorityBand, IndexedTask[]>): ResolvedQueueItem[] {
  const out: ResolvedQueueItem[] = [];
  for (const band of QUEUE_BAND_ORDER) {
    for (const item of grouped[band]) {
      out.push({ kind: 'task', key: item.key, task: item.task });
    }
  }
  return out;
}

export interface ScopeVisibility {
  tasks: boolean;
  schedules: boolean;
  jobs: boolean;
}

const SCOPE_VISIBILITY: Readonly<Record<QueueScope, ScopeVisibility>> = {
  all: { tasks: true, schedules: true, jobs: true },
  tasks: { tasks: true, schedules: false, jobs: false },
  schedules: { tasks: false, schedules: true, jobs: false },
  jobs: { tasks: false, schedules: false, jobs: true }
};

export function scopeVisibility(scope: QueueScope): ScopeVisibility {
  return SCOPE_VISIBILITY[scope];
}

export function buildVisibleQueueItems(
  scope: QueueScope,
  groupedTasks: Record<QueuePriorityBand, IndexedTask[]>,
  schedules: readonly SocialPostScheduleItem[],
  jobs: readonly IndexedJob[]
): ResolvedQueueItem[] {
  const show = scopeVisibility(scope);
  return [
    ...(show.tasks ? collectTaskItems(groupedTasks) : []),
    ...(show.schedules
      ? schedules.map((schedule): ResolvedQueueItem => ({ kind: 'schedule', key: scheduleRowKey(schedule), schedule }))
      : []),
    ...(show.jobs ? jobs.map((entry): ResolvedQueueItem => ({ kind: 'job', key: entry.key, job: entry.job })) : [])
  ];
}

export function resolveActiveSelectionKey(
  visibleKeys: readonly string[],
  selectedKey: string | null,
  dismissed: boolean
): string | null {
  if (selectedKey && visibleKeys.includes(selectedKey)) return selectedKey;
  if (dismissed) return null;
  return visibleKeys[0] ?? null;
}

export function formatIsoTimestamp(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString(locale.startsWith('en') ? 'en-US' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

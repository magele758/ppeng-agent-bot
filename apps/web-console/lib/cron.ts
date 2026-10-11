export type CronPreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

export type CronJobInfo = {
  id: string;
  sessionId: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: 'every_ms' | 'cron5' | 'once_at';
  scheduleValue: string;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

const CRON_USER_RE = /^\[cron:([^\]]+)\]\s*/;

export function parseCronUserPrompt(text: string): { name: string; body: string } | null {
  const m = text.match(CRON_USER_RE);
  if (!m) return null;
  return { name: m[1] ?? '', body: text.slice(m[0].length) };
}

export function cronFromTime(opts: {
  hour: number;
  minute: number;
  preset: Exclude<CronPreset, 'custom'>;
  weekday?: number;
}): string {
  const minute = clampInt(opts.minute, 0, 59);
  const hour = clampInt(opts.hour, 0, 23);
  const weekday = clampInt(opts.weekday ?? 1, 0, 6);
  if (opts.preset === 'hourly') return `${minute} * * * *`;
  if (opts.preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (opts.preset === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  return `${minute} ${hour} * * *`;
}

export function routinePrecheckPayload(
  kind: 'none' | 'script' | 'predicate',
  source: string
): { kind: 'script' | 'predicate'; source: string } | undefined {
  if (kind === 'none') return undefined;
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  return { kind, source: trimmed };
}

export function parseTimeValue(value: string): { hour: number; minute: number } {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 9, minute: 0 };
  return { hour: clampInt(Number(m[1]), 0, 23), minute: clampInt(Number(m[2]), 0, 59) };
}

export function formatTimeValue(hour: number, minute: number): string {
  return `${String(clampInt(hour, 0, 23)).padStart(2, '0')}:${String(clampInt(minute, 0, 59)).padStart(2, '0')}`;
}

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dom, month, dow] = parts;
  if (dom === '*' && month === '*') {
    if (hour === '*' && minute !== '*') return `每小时的 ${minute} 分`;
    if (dow === '*') return `每天 ${pad(hour)}:${pad(minute)}`;
    if (dow === '1-5') return `工作日 ${pad(hour)}:${pad(minute)}`;
    if (/^[0-6]$/.test(dow ?? '')) return `每周${weekdayLabel(Number(dow))} ${pad(hour)}:${pad(minute)}`;
  }
  return expr;
}

function weekdayLabel(n: number): string {
  return ['日', '一', '二', '三', '四', '五', '六'][n] ?? String(n);
}

function pad(raw: string | undefined): string {
  if (raw == null || raw === '*') return '**';
  return raw.padStart(2, '0');
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

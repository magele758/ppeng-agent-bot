/** Map Lab autonomy UI → permissionMode */

export type AutonomyLevel = 'supervised' | 'balanced' | 'autonomous';

export type SessionUsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type SessionRunOutcome = {
  kind: 'completed' | 'idle' | 'waiting_approval' | 'failed' | 'aborted';
  reason: string;
};

export type SessionChromeMeta = {
  status: string;
  permissionMode: string;
  outcome?: SessionRunOutcome;
  createdAt?: string;
  updatedAt?: string;
  /** Present only if the session already persisted a last-run duration. */
  lastRunDurationMs?: number;
  usageCostUsd?: number;
  usageTotals?: SessionUsageTotals;
  goalCondition?: string;
  goalEnabled?: boolean;
  goalTurnsUsed?: number;
  goalMaxTurns?: number;
  goalLedger?: Array<{ met?: boolean; reason?: string }>;
};

export type SessionTiming = {
  createdAt?: string;
  updatedAt?: string;
};

export type FeedMessageTime = {
  role?: string;
  createdAt?: unknown;
};

export function permissionToAutonomy(mode: string | undefined): AutonomyLevel {
  if (mode === 'ask' || mode === 'plan') return 'supervised';
  if (mode === 'bypass') return 'autonomous';
  return 'balanced';
}

export function autonomyToPermission(level: AutonomyLevel): string {
  if (level === 'supervised') return 'ask';
  if (level === 'autonomous') return 'bypass';
  return 'auto';
}

export function autonomyLabel(level: AutonomyLevel): string {
  if (level === 'supervised') return '全程审批';
  if (level === 'autonomous') return '全自动';
  return '常见自动';
}

export function autonomyOptionLabel(level: AutonomyLevel): string {
  if (level === 'supervised') return '全程审批 · Approve all';
  if (level === 'autonomous') return '全自动 · Full auto';
  return '常见自动 · Auto low-risk';
}

export function formatCostUsd(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

export function latestGoalMet(meta: SessionChromeMeta): boolean | null {
  if (!meta.goalEnabled && !meta.goalCondition) return null;
  const ledger = meta.goalLedger;
  if (!Array.isArray(ledger) || !ledger.length) return false;
  const last = ledger[ledger.length - 1];
  return last?.met === true;
}

function readIsoTime(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

function readTokenCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.floor(raw);
}

export function parseUsageTotals(raw: unknown): SessionUsageTotals | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const inputTokens = readTokenCount(o.inputTokens);
  const outputTokens = readTokenCount(o.outputTokens);
  const totalTokens = readTokenCount(o.totalTokens);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

export function hasRealUsageTotals(totals: SessionUsageTotals | undefined): boolean {
  if (!totals) return false;
  return [totals.inputTokens, totals.outputTokens, totals.totalTokens].some(
    (n) => typeof n === 'number' && n > 0
  );
}

export function parseTimeMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/** Compact token count for the feed footer (`12.4k`, `3.1k`). */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    const rounded = k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '');
    return `${rounded}k`;
  }
  const m = n / 1_000_000;
  const rounded = m >= 10 ? m.toFixed(1).replace(/\.0$/, '') : m.toFixed(2).replace(/\.?0+$/, '');
  return `${rounded}M`;
}

export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return s ? `${min}m ${s}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  if (hr < 24) return m ? `${hr}h ${m}m` : `${hr}h`;
  const d = Math.floor(hr / 24);
  const h = hr % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Wall time of the conversation: first user message → last message
 * (or `now` while running). Falls back to session createdAt/updatedAt.
 * Does not invent per-turn token math.
 */
export function conversationElapsedMs(input: {
  messages?: FeedMessageTime[];
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunDurationMs?: unknown;
  running?: boolean;
  now?: number;
  runStartedAt?: number;
}): number | undefined {
  if (
    !input.running &&
    typeof input.lastRunDurationMs === 'number' &&
    Number.isFinite(input.lastRunDurationMs) &&
    input.lastRunDurationMs >= 0
  ) {
    return input.lastRunDurationMs;
  }
  const now = input.now ?? Date.now();
  const times: number[] = [];
  let firstUser: number | undefined;
  for (const m of input.messages ?? []) {
    const t = parseTimeMs(m.createdAt);
    if (t == null) continue;
    times.push(t);
    if (firstUser == null && m.role === 'user') firstUser = t;
  }
  const firstAny = times.length ? Math.min(...times) : undefined;
  const lastAny = times.length ? Math.max(...times) : undefined;
  const start = firstUser ?? firstAny ?? parseTimeMs(input.createdAt) ?? input.runStartedAt;
  const end = input.running ? now : (lastAny ?? parseTimeMs(input.updatedAt));
  if (start == null || end == null || end < start) return undefined;
  if (end === start && times.length === 0 && !input.running) return undefined;
  return end - start;
}

export type ChatFeedStatsLabels = {
  elapsed?: string;
  input?: string;
  output?: string;
  ended?: string;
  sessionEnded?: string;
};

function feedTimeLocale(locale: string | undefined): string {
  if (!locale || locale === 'zh' || locale === 'zh-CN') return 'zh-CN';
  if (locale === 'en' || locale.startsWith('en-')) return 'en';
  return locale;
}

/** Month, day, and clock — same fields as context replay and bot activity. */
export function formatFeedEndTime(ms: number, locale?: string): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return new Intl.DateTimeFormat(feedTimeLocale(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(ms);
}

export function formatChatFeedStatsLine(input: {
  elapsedMs?: number;
  usageTotals?: SessionUsageTotals;
  usageCostUsd?: number;
  endedAtMs?: number;
  sessionEnded?: boolean;
  labels?: ChatFeedStatsLabels;
  locale?: string;
}): string | null {
  const elapsedLabel = input.labels?.elapsed ?? '执行';
  const inputLabel = input.labels?.input ?? '输入';
  const outputLabel = input.labels?.output ?? '输出';
  const parts: string[] = [];
  if (typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0) {
    parts.push(`${elapsedLabel} ${formatElapsedMs(input.elapsedMs)}`);
  }
  if (hasRealUsageTotals(input.usageTotals)) {
    const inn = input.usageTotals?.inputTokens;
    const out = input.usageTotals?.outputTokens;
    const tot = input.usageTotals?.totalTokens;
    if ((typeof inn === 'number' && inn > 0) || (typeof out === 'number' && out > 0)) {
      parts.push(`${inputLabel} ${typeof inn === 'number' && inn > 0 ? formatCompactTokens(inn) : '—'}`);
      parts.push(`${outputLabel} ${typeof out === 'number' && out > 0 ? formatCompactTokens(out) : '—'}`);
    } else if (typeof tot === 'number' && tot > 0) {
      parts.push(`${formatCompactTokens(tot)} tok`);
    }
  }
  if (typeof input.usageCostUsd === 'number' && Number.isFinite(input.usageCostUsd) && input.usageCostUsd > 0) {
    parts.push(formatCostUsd(input.usageCostUsd));
  }
  const clock = formatFeedEndTime(input.endedAtMs ?? Number.NaN, input.locale);
  if (clock) {
    const endedLabel = input.sessionEnded
      ? (input.labels?.sessionEnded ?? '会话结束')
      : (input.labels?.ended ?? '结束');
    parts.push(`${endedLabel} ${clock}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export function parseSessionOutcome(raw: unknown): SessionRunOutcome | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (
    kind !== 'completed' &&
    kind !== 'idle' &&
    kind !== 'waiting_approval' &&
    kind !== 'failed' &&
    kind !== 'aborted'
  ) {
    return undefined;
  }
  const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim() : 'unknown';
  return { kind, reason };
}

export function parseSessionChrome(
  metadata: Record<string, unknown> | undefined,
  status: string,
  timing?: SessionTiming
): SessionChromeMeta {
  const m = metadata ?? {};
  const lastRunDurationMs =
    typeof m.lastRunDurationMs === 'number' && Number.isFinite(m.lastRunDurationMs)
      ? m.lastRunDurationMs
      : undefined;
  return {
    status,
    permissionMode: typeof m.permissionMode === 'string' ? m.permissionMode : 'auto',
    createdAt: readIsoTime(timing?.createdAt),
    updatedAt: readIsoTime(timing?.updatedAt),
    usageCostUsd: typeof m.usageCostUsd === 'number' ? m.usageCostUsd : undefined,
    usageTotals: parseUsageTotals(m.usageTotals),
    lastRunDurationMs,
    outcome: parseSessionOutcome(m.outcome),
    goalCondition: typeof m.goalCondition === 'string' ? m.goalCondition : undefined,
    goalEnabled: m.goalEnabled === true || (typeof m.goalCondition === 'string' && m.goalCondition.trim().length > 0),
    goalTurnsUsed: typeof m.goalTurnsUsed === 'number' ? m.goalTurnsUsed : undefined,
    goalMaxTurns: typeof m.goalMaxTurns === 'number' ? m.goalMaxTurns : undefined,
    goalLedger: Array.isArray(m.goalLedger) ? (m.goalLedger as SessionChromeMeta['goalLedger']) : undefined
  };
}

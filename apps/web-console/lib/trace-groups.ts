export type TraceRow = { kind: string; ts: string; payload?: unknown };

export type TraceGroupKind = 'turn' | 'span';

export type TraceGroup = {
  id: string;
  turnIndex: number;
  kind: TraceGroupKind;
  label: string;
  startTs: string;
  endTs: string;
  durationMs: number | null;
  events: TraceRow[];
  hasError: boolean;
};

const ERROR_KINDS = new Set([
  'model_error',
  'recovery_abort',
  'cancel',
  'turn_truncated',
  'refusal_preservation'
]);

function isErrorKind(kind: string, payload?: unknown): boolean {
  if (kind === 'goal_eval') return unmetGoal(payload);
  if (ERROR_KINDS.has(kind)) return true;
  return kind.includes('error') || kind.includes('fail');
}

function unmetGoal(payload: unknown): boolean {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  return p.met === false;
}

export type ErrorHintCode = 'modelError' | 'recoveryAbort' | 'cancel' | 'truncated' | 'goalUnmet' | 'generic';

/** Maps an error-ish trace kind to an i18n hint code (`ops.hint.<code>.what|why|next`). */
export function errorHintCode(kind: string): ErrorHintCode {
  switch (kind) {
    case 'model_error':
      return 'modelError';
    case 'recovery_abort':
      return 'recoveryAbort';
    case 'cancel':
      return 'cancel';
    case 'turn_truncated':
      return 'truncated';
    case 'goal_eval':
      return 'goalUnmet';
    default:
      return 'generic';
  }
}

function textField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Free-text reason carried by an error event payload, if any. */
export function errorPayloadMessage(payload: unknown): string {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (unmetGoal(p)) {
    const sentence = textField(p, 'goal') || textField(p, 'title');
    const reason = textField(p, 'reason') || textField(p, 'message') || textField(p, 'error');
    if (sentence && reason) return `${sentence} — ${reason}`;
    return sentence || reason;
  }
  if (typeof p.message === 'string') return p.message;
  if (typeof p.error === 'string') return p.error;
  return '';
}

/** Group chronological events into turns (turn_start…turn_end) with loose buckets. */
export function groupTraceEvents(rows: TraceRow[]): TraceGroup[] {
  const sorted = [...rows].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const groups: TraceGroup[] = [];
  let current: TraceGroup | null = null;
  let turnIdx = 0;

  const flush = () => {
    if (!current) return;
    const start = Date.parse(current.startTs);
    const end = Date.parse(current.endTs);
    current.durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
    groups.push(current);
    current = null;
  };

  for (const ev of sorted) {
    if (ev.kind === 'turn_start' || !current) {
      if (current) flush();
      turnIdx += 1;
      const kind: TraceGroupKind = ev.kind === 'turn_start' ? 'turn' : 'span';
      current = {
        id: `turn-${turnIdx}-${ev.ts}`,
        turnIndex: turnIdx,
        kind,
        label: kind === 'turn' ? `Turn ${turnIdx}` : `Span ${turnIdx}`,
        startTs: ev.ts,
        endTs: ev.ts,
        durationMs: null,
        events: [ev],
        hasError: isErrorKind(ev.kind, ev.payload)
      };
      continue;
    }
    current.events.push(ev);
    current.endTs = ev.ts;
    if (isErrorKind(ev.kind, ev.payload)) current.hasError = true;
    if (ev.kind === 'turn_end' || ev.kind === 'cancel') {
      flush();
    }
  }
  flush();
  return groups;
}

export function maxDurationMs(groups: TraceGroup[]): number {
  let m = 1;
  for (const g of groups) {
    if (g.durationMs != null && g.durationMs > m) m = g.durationMs;
  }
  return m;
}

export type TraceTurnSummary = {
  toolCalls: number;
  errorEvents: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
};

function readNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** One-line facts about a turn, computed from its events (tool_start count, turn_end usage/cost). */
export function summarizeGroup(group: Pick<TraceGroup, 'events'>): TraceTurnSummary {
  let toolCalls = 0;
  let errorEvents = 0;
  let totalTokens: number | undefined;
  let costUsd: number | undefined;
  let model: string | undefined;
  for (const ev of group.events) {
    if (ev.kind === 'tool_start') toolCalls += 1;
    if (isErrorKind(ev.kind, ev.payload)) errorEvents += 1;
    if (ev.kind === 'turn_end' && ev.payload && typeof ev.payload === 'object') {
      const p = ev.payload as Record<string, unknown>;
      const usage = p.usage && typeof p.usage === 'object' ? (p.usage as Record<string, unknown>) : {};
      const total =
        readNumber(usage.totalTokens) ??
        (readNumber(usage.inputTokens) != null || readNumber(usage.outputTokens) != null
          ? (readNumber(usage.inputTokens) ?? 0) + (readNumber(usage.outputTokens) ?? 0)
          : undefined);
      if (total != null) totalTokens = (totalTokens ?? 0) + total;
      const cost = readNumber(p.costUsd);
      if (cost != null) costUsd = (costUsd ?? 0) + cost;
      const m = p.servedBy ?? p.model;
      if (typeof m === 'string' && m) model = m;
    }
  }
  return { toolCalls, errorEvents, totalTokens, costUsd, model };
}

export type TraceOverview = {
  turns: number;
  errorTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  totalTokens?: number;
  costUsd?: number;
};

/** Header numbers for a whole session trace. */
export function summarizeTrace(groups: TraceGroup[]): TraceOverview {
  const out: TraceOverview = { turns: groups.length, errorTurns: 0, toolCalls: 0, totalDurationMs: 0 };
  for (const g of groups) {
    if (g.hasError) out.errorTurns += 1;
    if (g.durationMs != null) out.totalDurationMs += g.durationMs;
    const s = summarizeGroup(g);
    out.toolCalls += s.toolCalls;
    if (s.totalTokens != null) out.totalTokens = (out.totalTokens ?? 0) + s.totalTokens;
    if (s.costUsd != null) out.costUsd = (out.costUsd ?? 0) + s.costUsd;
  }
  return out;
}

export type TraceFilter = { errorsOnly: boolean; query: string };

/**
 * `errorsOnly` keeps turns that contain an error; `query` keeps only events whose kind contains
 * the (case-insensitive) text and drops turns left with no events. Turn numbering is preserved.
 */
export function filterTraceGroups(groups: TraceGroup[], filter: TraceFilter): TraceGroup[] {
  const q = filter.query.trim().toLowerCase();
  let out = filter.errorsOnly ? groups.filter((g) => g.hasError) : groups;
  if (q) {
    out = out
      .map((g) => ({ ...g, events: g.events.filter((ev) => ev.kind.toLowerCase().includes(q)) }))
      .filter((g) => g.events.length > 0);
  }
  return out;
}

export { isErrorKind };

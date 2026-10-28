/**
 * Per conversation-turn feed stats (user utterance → assistant reply end,
 * including tool calls). Usage comes from turn_end traces; elapsed prefers
 * turn_start…turn_end wall time, then message timestamps.
 */

import {
  formatChatFeedStatsLine,
  formatElapsedMs,
  hasRealUsageTotals,
  parseTimeMs,
  parseUsageTotals,
  type ChatFeedStatsLabels,
  type SessionUsageTotals
} from './session-chrome.ts';

export type TurnFeedStatMessage = {
  role?: string;
  createdAt?: unknown;
};

export type TurnFeedTraceEvent = {
  kind: string;
  ts: string;
  payload?: unknown;
};

/** One user→assistant cycle in the chat feed (may cover multiple model turn_end events). */
export type ConversationTurnSlice = {
  /** Index of the leading user message in the feed array. */
  userIndex: number;
  /** Inclusive start index in the feed array (usually the user message). */
  startIndex: number;
  /** Inclusive end index of the last message belonging to this turn. */
  endIndex: number;
};

export type TurnFeedStat = {
  elapsedMs?: number;
  usageTotals?: SessionUsageTotals;
  usageCostUsd?: number;
  /** Wall-clock end of this turn. Absent while this turn is still open. */
  endedAtMs?: number;
  /** Last turn of a session that has finished. Its endedAtMs is when the session ended. */
  sessionEnded?: boolean;
  /** Pre-model startup for this user turn. Durations only; no message text. */
  startup?: StartupTiming;
};

export type StartupTiming = {
  totalMs?: number;
  slowest: string;
  slowestMs: number;
  phases: Array<{ phase: string; durationMs: number }>;
};

function isUserRole(role: unknown): boolean {
  return role === 'user';
}

/**
 * Split chronological messages into conversation turns: each slice starts at a
 * user message and runs until the message before the next user (or end).
 */
export function sliceConversationTurns(messages: TurnFeedStatMessage[]): ConversationTurnSlice[] {
  const slices: ConversationTurnSlice[] = [];
  let userIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (isUserRole(messages[i]?.role)) {
      if (userIndex >= 0) {
        slices.push({ userIndex, startIndex: userIndex, endIndex: i - 1 });
      }
      userIndex = i;
    }
  }
  if (userIndex >= 0) {
    slices.push({ userIndex, startIndex: userIndex, endIndex: messages.length - 1 });
  }
  return slices;
}

function readCostUsd(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const n = (payload as Record<string, unknown>).costUsd;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

type ModelTurnWindow = {
  startMs: number;
  endMs: number;
  usage?: SessionUsageTotals;
  costUsd?: number;
  /** Still in progress; endMs is "now", not a real end. */
  open?: boolean;
};

/**
 * Pair turn_start…turn_end (or cancel) into model-call windows with optional usage.
 * An unmatched trailing turn_start becomes an open window ending at `openEndMs`
 * (caller typically passes `now` while the session is still running).
 */
export function extractModelTurnWindows(
  events: TurnFeedTraceEvent[],
  opts?: { openEndMs?: number }
): ModelTurnWindow[] {
  const sorted = [...events].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const windows: ModelTurnWindow[] = [];
  let openStart: number | undefined;
  for (const ev of sorted) {
    const ts = parseTimeMs(ev.ts);
    if (ts == null) continue;
    if (ev.kind === 'turn_start') {
      openStart = ts;
      continue;
    }
    if (ev.kind === 'turn_end' || ev.kind === 'cancel') {
      const startMs = openStart ?? ts;
      const usage =
        ev.kind === 'turn_end'
          ? parseUsageTotals(
              ev.payload && typeof ev.payload === 'object'
                ? (ev.payload as Record<string, unknown>).usage
                : undefined
            )
          : undefined;
      const costUsd = ev.kind === 'turn_end' ? readCostUsd(ev.payload) : undefined;
      windows.push({ startMs, endMs: ts, usage, costUsd });
      openStart = undefined;
    }
  }
  if (openStart != null && typeof opts?.openEndMs === 'number' && opts.openEndMs >= openStart) {
    windows.push({ startMs: openStart, endMs: opts.openEndMs, open: true });
  }
  return windows;
}

function mergeUsageTotals(
  a: SessionUsageTotals | undefined,
  b: SessionUsageTotals | undefined
): SessionUsageTotals | undefined {
  if (!a && !b) return undefined;
  const inputTokens = (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0);
  const outputTokens = (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0);
  const totalTokens = (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0);
  const out: SessionUsageTotals = {};
  if (inputTokens > 0) out.inputTokens = inputTokens;
  if (outputTokens > 0) out.outputTokens = outputTokens;
  if (totalTokens > 0) out.totalTokens = totalTokens;
  return hasRealUsageTotals(out) ? out : undefined;
}

function messageWindowBounds(
  messages: TurnFeedStatMessage[],
  slice: ConversationTurnSlice,
  nextSlice: ConversationTurnSlice | undefined
): { startMs?: number; endMsExclusive?: number; lastMsgMs?: number } {
  const startMs = parseTimeMs(messages[slice.userIndex]?.createdAt);
  const nextUserMs = nextSlice ? parseTimeMs(messages[nextSlice.userIndex]?.createdAt) : undefined;
  let lastMsgMs: number | undefined;
  for (let i = slice.startIndex; i <= slice.endIndex; i += 1) {
    const t = parseTimeMs(messages[i]?.createdAt);
    if (t != null) lastMsgMs = lastMsgMs == null ? t : Math.max(lastMsgMs, t);
  }
  return { startMs, endMsExclusive: nextUserMs, lastMsgMs };
}

function windowOverlaps(
  win: ModelTurnWindow,
  startMs: number | undefined,
  endMsExclusive: number | undefined
): boolean {
  if (startMs == null) return false;
  if (win.endMs < startMs) return false;
  if (endMsExclusive != null && win.startMs >= endMsExclusive) return false;
  return true;
}

function latestReplyMs(messages: TurnFeedStatMessage[], slice: ConversationTurnSlice): number | undefined {
  let end: number | undefined;
  for (let i = slice.startIndex; i <= slice.endIndex; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role === 'user') continue;
    const t = parseTimeMs(msg.createdAt);
    if (t == null) continue;
    end = end == null ? t : Math.max(end, t);
  }
  return end;
}

const PHASE_LABELS: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    writer_claim: '写入占用',
    ensure_mcp: 'MCP 加载',
    resolve_file_policy: '文件策略',
    ingest_mailbox: '邮箱',
    auto_claim_task: '领取任务',
    claim_next_run: '领取下轮',
    ensure_workspace: '工作区',
    resolve_workspace: '工作区路径',
    pack_turn: '打包消息',
    build_system_prompt: '系统提示词',
    before_turn_hook: '开轮钩子',
    pick_turn_tools: '工具选择',
    before_model: '模型前检查',
    session_start_hook: '会话开始钩子',
    fit_model_request: '请求适配',
    auto_compact: '自动压缩',
    fold_messages: '折叠消息',
    fold_budget: '折叠预算',
    prepare_view: '准备视图',
    memory_appendix: '记忆附录',
    prepare_turn: '打包总耗时',
    seal_exposure: '共享曝光',
    embed_quotes: '引用嵌入',
    compact_fold: '压缩折叠',
    skill_catalog: '技能目录',
    skill_route: '技能路由',
    stable_prefix: '稳定前缀',
    dynamic_context: '动态上下文',
    system_prompt: '系统提示词合计',
    mcp_expand: 'MCP 展开',
    mcp_http_connect: 'MCP 连接',
    mcp_http_list: 'MCP 工具列表',
    mcp_stdio: 'MCP 本地进程',
    expire_bot_work: '过期工作',
    prepare_room: '房间准备',
    goal_intake: '目标接入',
    bind_goal: '绑定目标',
    assemble_loop: '组装循环',
    computer_use_begin: '计算机使用',
    admit: '准入'
  },
  en: {
    writer_claim: 'Writer claim',
    ensure_mcp: 'MCP load',
    resolve_file_policy: 'File policy',
    ingest_mailbox: 'Mailbox',
    auto_claim_task: 'Claim task',
    claim_next_run: 'Claim next run',
    ensure_workspace: 'Workspace',
    resolve_workspace: 'Workspace path',
    pack_turn: 'Pack messages',
    build_system_prompt: 'System prompt',
    before_turn_hook: 'Before-turn hook',
    pick_turn_tools: 'Tool selection',
    before_model: 'Pre-model check',
    session_start_hook: 'Session-start hook',
    fit_model_request: 'Request fit',
    auto_compact: 'Auto compact',
    fold_messages: 'Fold messages',
    fold_budget: 'Fold budget',
    prepare_view: 'Prepare view',
    memory_appendix: 'Memory appendix',
    prepare_turn: 'Pack total',
    seal_exposure: 'Shared exposure',
    embed_quotes: 'Embed quotes',
    compact_fold: 'Compact fold',
    skill_catalog: 'Skill catalog',
    skill_route: 'Skill routing',
    stable_prefix: 'Stable prefix',
    dynamic_context: 'Dynamic context',
    system_prompt: 'System prompt total',
    mcp_expand: 'MCP expansion',
    mcp_http_connect: 'MCP connect',
    mcp_http_list: 'MCP tool list',
    mcp_stdio: 'MCP local process',
    expire_bot_work: 'Expire work',
    prepare_room: 'Room prep',
    goal_intake: 'Goal intake',
    bind_goal: 'Bind goal',
    assemble_loop: 'Assemble loop',
    computer_use_begin: 'Computer use',
    admit: 'Admission'
  }
};

function startupLang(locale?: string): 'zh' | 'en' {
  return locale?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

function formatStartupMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) {
    const sec = ms / 1000;
    return `${sec.toFixed(1).replace(/\.0$/, '')}s`;
  }
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return formatElapsedMs(ms);
}

function phaseLabel(phase: string, locale?: string): string {
  return PHASE_LABELS[startupLang(locale)][phase] ?? phase;
}

function readTracePayload(event: TurnFeedTraceEvent): Record<string, unknown> | undefined {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return payload as Record<string, unknown>;
}

function startupInWindow(
  events: TurnFeedTraceEvent[],
  startMs: number | undefined,
  endMsExclusive: number | undefined
): StartupTiming | undefined {
  if (startMs == null) return undefined;
  const phases = new Map<string, number>();
  let totalMs: number | undefined;
  let namedSlowest: string | undefined;
  let namedSlowestMs = -1;
  for (const event of events) {
    if (event.kind !== 'startup_phase') continue;
    const ts = parseTimeMs(event.ts);
    if (ts == null || ts < startMs) continue;
    if (endMsExclusive != null && ts >= endMsExclusive) continue;
    const payload = readTracePayload(event);
    if (!payload || typeof payload.phase !== 'string' || !/^[a-z0-9_]+$/.test(payload.phase)) continue;
    if (payload.phase === 'ready') {
      if (typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)) totalMs = payload.durationMs;
      if (typeof payload.slowest === 'string' && /^[a-z0-9_]+$/.test(payload.slowest)) namedSlowest = payload.slowest;
      if (typeof payload.slowestMs === 'number' && Number.isFinite(payload.slowestMs)) namedSlowestMs = payload.slowestMs;
      const map = payload.phases;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const [name, ms] of Object.entries(map)) {
          if (/^[a-z0-9_]+$/.test(name) && typeof ms === 'number' && Number.isFinite(ms) && ms > 0) phases.set(name, ms);
        }
      }
      continue;
    }
    if (typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs > 0) {
      phases.set(payload.phase, payload.durationMs);
    }
  }
  let slowest = namedSlowest;
  let slowestMs = namedSlowestMs;
  for (const [name, ms] of phases) {
    if (!slowest || ms > slowestMs) {
      slowest = name;
      slowestMs = ms;
    }
  }
  if (!slowest || slowestMs < 0) return undefined;
  if (slowestMs <= 0 && (totalMs ?? 0) <= 0) return undefined;
  const listed = [...phases.entries()]
    .filter(([name, ms]) => name !== 'ready' && ms > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([phase, durationMs]) => ({ phase, durationMs }));
  return { ...(typeof totalMs === 'number' ? { totalMs } : {}), slowest, slowestMs, phases: listed };
}

export function formatStartupClause(timing: StartupTiming, locale?: string, labels?: { startup?: string; slowest?: string }): string {
  const startup = labels?.startup ?? (startupLang(locale) === 'en' ? 'Startup' : '启动');
  const slowestLabel = labels?.slowest ?? (startupLang(locale) === 'en' ? 'Slowest' : '最慢');
  const parts = [
    typeof timing.totalMs === 'number' ? `${startup} ${formatStartupMs(timing.totalMs)}` : startup,
    `${slowestLabel} ${phaseLabel(timing.slowest, locale)} ${formatStartupMs(timing.slowestMs)}`
  ];
  for (const phase of timing.phases) {
    if (phase.phase === timing.slowest) continue;
    parts.push(`${phaseLabel(phase.phase, locale)} ${formatStartupMs(phase.durationMs)}`);
  }
  return parts.join(' · ');
}

/**
 * Build one stats object per conversation turn. Returns null entries when that
 * turn has neither elapsed, real usage/cost, an end time, nor startup timing.
 */
export function buildTurnFeedStats(input: {
  messages: TurnFeedStatMessage[];
  traces?: TurnFeedTraceEvent[];
  /** While the latest turn is still running, extend its end to `now`. */
  running?: boolean;
  /** Latest turn has not finished (running, or waiting on the user). */
  sessionOpen?: boolean;
  now?: number;
}): Array<TurnFeedStat | null> {
  const slices = sliceConversationTurns(input.messages);
  if (!slices.length) return [];
  const now = input.now ?? Date.now();
  const modelWindows = extractModelTurnWindows(input.traces ?? [], {
    openEndMs: input.running ? now : undefined
  });
  const out: Array<TurnFeedStat | null> = [];

  for (let si = 0; si < slices.length; si += 1) {
    const slice = slices[si]!;
    const next = slices[si + 1];
    const bounds = messageWindowBounds(input.messages, slice, next);
    const sessionOpen = Boolean(input.running || input.sessionOpen);
    const isLiveTail = Boolean(input.running) && si === slices.length - 1;
    const isOpenTail = sessionOpen && si === slices.length - 1;

    let usage: SessionUsageTotals | undefined;
    let costUsd = 0;
    let hasCost = false;
    let firstModelStart: number | undefined;
    let lastModelEnd: number | undefined;
    let lastClosedEnd: number | undefined;

    for (const win of modelWindows) {
      if (!windowOverlaps(win, bounds.startMs, bounds.endMsExclusive)) continue;
      usage = mergeUsageTotals(usage, win.usage);
      if (typeof win.costUsd === 'number') {
        costUsd += win.costUsd;
        hasCost = true;
      }
      firstModelStart =
        firstModelStart == null ? win.startMs : Math.min(firstModelStart, win.startMs);
      lastModelEnd = lastModelEnd == null ? win.endMs : Math.max(lastModelEnd, win.endMs);
      if (!win.open) {
        lastClosedEnd = lastClosedEnd == null ? win.endMs : Math.max(lastClosedEnd, win.endMs);
      }
    }

    let elapsedMs: number | undefined;
    if (firstModelStart != null) {
      const end = isLiveTail ? now : (lastModelEnd ?? bounds.lastMsgMs ?? firstModelStart);
      if (end >= firstModelStart) elapsedMs = end - firstModelStart;
    } else if (bounds.startMs != null) {
      const endMs = isLiveTail ? now : bounds.lastMsgMs;
      if (endMs != null && endMs >= bounds.startMs && (endMs > bounds.startMs || isLiveTail)) {
        elapsedMs = endMs - bounds.startMs;
      }
    }

    const stat: TurnFeedStat = {};
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      stat.elapsedMs = elapsedMs;
    }
    if (usage) stat.usageTotals = usage;
    if (hasCost && costUsd > 0) stat.usageCostUsd = Math.round(costUsd * 1e6) / 1e6;
    if (!isOpenTail) {
      const endedAtMs = lastClosedEnd ?? latestReplyMs(input.messages, slice);
      if (endedAtMs != null) {
        stat.endedAtMs = endedAtMs;
        if (!sessionOpen && si === slices.length - 1) stat.sessionEnded = true;
      }
    }

    const startup = startupInWindow(input.traces ?? [], bounds.startMs, bounds.endMsExclusive);
    if (startup) stat.startup = startup;

    const hasAnything =
      stat.elapsedMs != null ||
      hasRealUsageTotals(stat.usageTotals) ||
      (typeof stat.usageCostUsd === 'number' && stat.usageCostUsd > 0) ||
      stat.endedAtMs != null ||
      stat.startup != null;
    out.push(hasAnything ? stat : null);
  }

  return out;
}

export function formatTurnFeedStatsLine(
  stat: TurnFeedStat | null | undefined,
  labels?: ChatFeedStatsLabels & { startup?: string; slowest?: string },
  locale?: string
): string | null {
  if (!stat) return null;
  const base = formatChatFeedStatsLine({
    elapsedMs: stat.elapsedMs,
    usageTotals: stat.usageTotals,
    usageCostUsd: stat.usageCostUsd,
    endedAtMs: stat.endedAtMs,
    sessionEnded: stat.sessionEnded,
    labels,
    locale
  });
  const startup = stat.startup ? formatStartupClause(stat.startup, locale, labels) : null;
  return [base, startup].filter(Boolean).join(' · ') || null;
}

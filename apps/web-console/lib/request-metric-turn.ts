/**
 * 选中「上下文时间」的哪一轮，就返回那一轮的已发送请求指标。
 *
 * 字段对应（ContextStackPanel / GET /api/sessions/:id/context-snapshots）：
 * - 「第 N 次」= snapshot.turn（context_stack_snapshots.turn_index，1-based）。
 *   滑块文案是 play.contextStack.replayAt。live 帧 turn 为 null，文案是「当前 · 最新」，
 *   不是另一次已发送请求；查询时 selectedTurnNumber 传 null。
 * - 已发送数字 = RequestMetric / core RequestMetrics：
 *   estimatedTokens、windowTokens、actualInputTokens、sentAt、sessionId。
 *   可写在 snapshots[] 对应轮上，或写在 requests[] 且带 turn。
 *   现有接口只在 latestRequest 上保留最近一次。没有 turn 时：sentAt 等于
 *   最大一轮快照的 sentAt 或 createdAt，就更新这一轮；否则对到最大的
 *   snapshot.turn。若该轮已有不同的 estimatedTokens，则另起下一轮。
 *   时间碰巧和更早轮相同，也不改写那一轮。
 * - windowPercent = windowTokens > 0 时 Number((estimatedTokens / windowTokens * 100).toFixed(1))，
 *   与面板现在的 toFixed(1) 一致；否则 null。
 * - upstreamInputTokens = actualInputTokens（有限数字，含 0）；缺省或 null 保持 null，不用别的轮填。
 * - sentAtLabel = sentAt，没有则用该快照 createdAt，再没有则 null。
 *   这是原始时间字符串，界面仍用 toLocaleTimeString(locale) 显示。
 * - snapshots[].blocks[].tokens 是上下文色块，不是已发送请求估算，不参与计算。
 * - source.sessionId 与记录上的 sessionId 都存在且不同时丢掉该记录，避免串到另一条对话。
 * 没有任何 estimatedTokens 时返回空数组。
 */

export interface SentRequestMetric {
  /** 1-based，对应「第 N 次」 */
  turnNumber: number;
  estimatedTokens: number;
  /** 显示用的百分数，例如 62.7；未知为 null */
  windowPercent: number | null;
  /** 未知为 null，禁止用别的轮填 */
  upstreamInputTokens: number | null;
  sentAtLabel: string | null;
}

export interface SentRequestInput {
  turn?: number;
  id?: string;
  sessionId?: string;
  sentAt?: string | null;
  createdAt?: string | null;
  estimatedTokens?: number;
  windowTokens?: number | null;
  actualInputTokens?: number | null;
  /** 上下文色块。只为接住现有快照字段，不拿来当已发送 token。 */
  blocks?: readonly { tokens?: number }[];
}

export interface SentRequestSource {
  sessionId?: string;
  snapshots?: readonly SentRequestInput[];
  /** 逐轮已发送请求。每一项的 turn 就是「第 N 次」。 */
  requests?: readonly SentRequestInput[];
  latestRequest?: SentRequestInput | null;
}

interface Draft {
  turnNumber: number;
  estimatedTokens: number;
  windowTokens: number | null;
  upstreamInputTokens: number | null;
  sentAtLabel: string | null;
}

function readTurn(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function readWindow(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function readUpstream(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function readLabel(sentAt: string | null | undefined, createdAt: string | null | undefined): string | null {
  if (typeof sentAt === 'string' && sentAt.trim()) return sentAt;
  if (typeof createdAt === 'string' && createdAt.trim()) return createdAt;
  return null;
}

function windowPercent(estimatedTokens: number, windowTokens: number | null): number | null {
  if (windowTokens == null) return null;
  return Number(((estimatedTokens / windowTokens) * 100).toFixed(1));
}

function belongs(record: SentRequestInput, sessionId: string | undefined): boolean {
  if (!sessionId || typeof record.sessionId !== 'string' || !record.sessionId) return true;
  return record.sessionId === sessionId;
}

function timeKey(record: SentRequestInput): string {
  if (typeof record.createdAt === 'string') return record.createdAt;
  if (typeof record.sentAt === 'string') return record.sentAt;
  return '';
}

function compareSnapshots(a: SentRequestInput, b: SentRequestInput): number {
  const turnA = readTurn(a.turn) ?? 0;
  const turnB = readTurn(b.turn) ?? 0;
  if (turnA !== turnB) return turnA - turnB;
  const timeA = timeKey(a);
  const timeB = timeKey(b);
  if (timeA < timeB) return -1;
  if (timeA > timeB) return 1;
  const idA = a.id ?? '';
  const idB = b.id ?? '';
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
}

function draftFrom(record: SentRequestInput): Draft | undefined {
  if (typeof record.estimatedTokens !== 'number' || !Number.isFinite(record.estimatedTokens)) return undefined;
  return {
    turnNumber: 0,
    estimatedTokens: record.estimatedTokens,
    windowTokens: readWindow(record.windowTokens),
    upstreamInputTokens: readUpstream(record.actualInputTokens),
    sentAtLabel: readLabel(record.sentAt, record.createdAt)
  };
}

function writeTurn(map: Map<number, Draft>, turn: number, next: Draft, replaceDifferentSend: boolean): void {
  const draft = { ...next, turnNumber: turn };
  const prev = map.get(turn);
  if (!prev) {
    map.set(turn, draft);
    return;
  }
  if (prev.estimatedTokens !== draft.estimatedTokens) {
    if (replaceDifferentSend) map.set(turn, draft);
    return;
  }
  if (prev.windowTokens == null && draft.windowTokens != null) prev.windowTokens = draft.windowTokens;
  if (prev.upstreamInputTokens == null && draft.upstreamInputTokens != null) prev.upstreamInputTokens = draft.upstreamInputTokens;
  if (prev.sentAtLabel == null && draft.sentAtLabel != null) prev.sentAtLabel = draft.sentAtLabel;
}

function placeLatest(
  map: Map<number, Draft>,
  latest: SentRequestInput,
  snapshots: readonly SentRequestInput[],
  sessionId: string | undefined
): void {
  if (!belongs(latest, sessionId)) return;
  const draft = draftFrom(latest);
  if (!draft) return;
  const explicit = readTurn(latest.turn);
  if (explicit != null) {
    writeTurn(map, explicit, draft, true);
    return;
  }
  const snapshotTurns = snapshots
    .map((snap) => readTurn(snap.turn))
    .filter((turn): turn is number => turn != null);
  const maxSnapshotTurn = snapshotTurns.length === 0 ? undefined : Math.max(...snapshotTurns);
  const sentAt = typeof latest.sentAt === 'string' ? latest.sentAt : '';
  if (sentAt && maxSnapshotTurn != null) {
    const latestSnapshot = [...snapshots].reverse().find((snap) => readTurn(snap.turn) === maxSnapshotTurn);
    if (latestSnapshot && (latestSnapshot.sentAt === sentAt || latestSnapshot.createdAt === sentAt)) {
      writeTurn(map, maxSnapshotTurn, draft, true);
      return;
    }
  }
  const knownTurns = [...map.keys(), ...snapshotTurns];
  if (knownTurns.length === 0) {
    writeTurn(map, 1, draft, true);
    return;
  }
  const maxTurn = Math.max(...knownTurns);
  const prev = map.get(maxTurn);
  if (!prev || prev.estimatedTokens === draft.estimatedTokens) {
    writeTurn(map, maxTurn, draft, false);
    return;
  }
  writeTurn(map, maxTurn + 1, draft, true);
}

function publish(map: Map<number, Draft>): SentRequestMetric[] {
  return [...map.values()]
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((item) => ({
      turnNumber: item.turnNumber,
      estimatedTokens: item.estimatedTokens,
      windowPercent: windowPercent(item.estimatedTokens, item.windowTokens),
      upstreamInputTokens: item.upstreamInputTokens,
      sentAtLabel: item.sentAtLabel
    }));
}

export function toSentRequestMetrics(source: SentRequestSource): SentRequestMetric[] {
  if (!source || typeof source !== 'object') return [];
  const sessionId = typeof source.sessionId === 'string' && source.sessionId ? source.sessionId : undefined;
  const snapshots = (Array.isArray(source.snapshots) ? source.snapshots : [])
    .filter((snap) => belongs(snap, sessionId))
    .sort(compareSnapshots);
  const requests = Array.isArray(source.requests) ? source.requests : [];
  const map = new Map<number, Draft>();
  for (const snap of snapshots) {
    const turn = readTurn(snap.turn);
    const draft = turn == null ? undefined : draftFrom(snap);
    if (turn == null || !draft) continue;
    writeTurn(map, turn, draft, true);
  }
  for (const request of requests) {
    if (!belongs(request, sessionId)) continue;
    const turn = readTurn(request.turn);
    const draft = turn == null ? undefined : draftFrom(request);
    if (turn == null || !draft) continue;
    writeTurn(map, turn, draft, true);
  }
  if (source.latestRequest) placeLatest(map, source.latestRequest, snapshots, sessionId);
  return publish(map);
}

function copyMetric(metric: SentRequestMetric): SentRequestMetric {
  return {
    turnNumber: metric.turnNumber,
    estimatedTokens: metric.estimatedTokens,
    windowPercent: metric.windowPercent,
    upstreamInputTokens: metric.upstreamInputTokens,
    sentAtLabel: metric.sentAtLabel
  };
}

function isSentMetric(value: SentRequestMetric): boolean {
  return !!value
    && Number.isInteger(value.turnNumber)
    && value.turnNumber >= 1
    && typeof value.estimatedTokens === 'number'
    && Number.isFinite(value.estimatedTokens);
}

export function metricForTurn(input: {
  sent: SentRequestMetric[];
  /** null 表示滑块在「当前 · 最新」 */
  selectedTurnNumber: number | null;
}): { status: 'waiting' } | { status: 'ready'; metric: SentRequestMetric; isLatest: boolean } {
  const sent = Array.isArray(input?.sent) ? input.sent.filter(isSentMetric) : [];
  if (sent.length === 0) return { status: 'waiting' };
  let latest = sent[0]!;
  for (const item of sent) {
    if (item.turnNumber >= latest.turnNumber) latest = item;
  }
  if (input.selectedTurnNumber == null || input.selectedTurnNumber === latest.turnNumber) {
    return { status: 'ready', metric: copyMetric(latest), isLatest: true };
  }
  let found: SentRequestMetric | undefined;
  for (const item of sent) {
    if (item.turnNumber === input.selectedTurnNumber) found = item;
  }
  if (!found) return { status: 'waiting' };
  return { status: 'ready', metric: copyMetric(found), isLatest: false };
}

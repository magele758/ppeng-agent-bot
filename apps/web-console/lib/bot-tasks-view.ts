import type { BotInfo } from './types.ts';

export interface BotTaskArtifact {
  id: string;
  fileName: string;
  mimeType: string;
  totalBytes: number;
}

export interface BotTaskReceipt {
  id: string;
  connectorId: string;
  toolName: string;
  state: string;
  result?: unknown;
  error?: string;
}

export interface BotTaskDelivery {
  taskId: string;
  sessionId: string;
  attempt: number;
  createdAt: string;
  executionStatus: string;
  report: string;
  failureReason: string | null;
  verification: 'unverified';
  manualReview?: { accepted: boolean; at: string };
  summary?: string;
  artifacts: BotTaskArtifact[];
  receipts: BotTaskReceipt[];
}

export type BotTaskDeliveryVersion = BotTaskDelivery;

export interface BotTaskItem {
  id: string;
  targetBotId: string;
  requesterBotId?: string;
  input: string;
  status: string;
  attempt?: number;
  deadline?: string;
  result?: unknown;
  resultSummary?: string;
  failureReason?: string;
  createdAt?: string;
  updatedAt?: string;
  delivery?: BotTaskDelivery;
  deliveryVersions?: BotTaskDeliveryVersion[];
  deliveryReview?: { accepted: boolean; at: string };
  sourceDelivery?: { taskId: string; attempt: number };
  parentTaskId?: string;
}

export type BotTaskDetail = BotTaskItem;

export interface BotTaskStatusRow {
  bot: BotInfo;
  status: string;
  pending: number;
  activeWorkCount?: number;
  sessionId?: string | null;
  control?: { paused: boolean; disabled: boolean };
  taskCounts?: Record<string, number>;
}

export interface BotCollaborationGroup {
  id: string;
  goal: string;
  status: string;
  completed: number;
  total: number;
  summary?: string;
  members: BotTaskItem[];
  blockers: BotTaskItem[];
  deliveries: BotTaskItem[];
}

export type BotTaskBand = 'attention' | 'active' | 'history';
export type BotTaskTimeRange = 'all' | 'today' | '3d' | '7d';

export interface BotTaskFilterState {
  query: string;
  botId: string;
  band: 'all' | BotTaskBand;
  timeRange: BotTaskTimeRange;
}

export interface BotTaskFacetCounts {
  total: number;
  byBand: Record<BotTaskBand, number>;
  byBot: Record<string, number>;
  byTime: Record<BotTaskTimeRange, number>;
}

export type BotNameLookup = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

const MAX_TITLE_CHARS = 88;
const MAX_PREVIEW_CHARS = 120;

const UNRESOLVED_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'unknown']);
const ATTENTION_STATUSES = new Set(['failed', 'unknown', 'waiting_approval', 'blocked']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_condition', 'in_progress', 'pending']);

const TIME_RANGE_MS: Record<Exclude<BotTaskTimeRange, 'all'>, number> = {
  today: 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const LEADING_WRAPPERS: readonly RegExp[] = [
  /^Message from [^:\n]{1,140}:\s*/i,
  /^\[(?:delegated executor|goal:[^\]]+|system|OPC OS[^\]]*)\]\s*/i,
  /^OPC OS\s*阶段工单\s*[:：\-—]*\s*/i,
  /^阶段工单\s*[:：\-—]*\s*/i,
];

const GOAL_CONTINUE_RE = /^Continue goal\s+\S+(?:\s+under revision\s+\d+)?\.?\s*Objective:\s*([\s\S]+)$/i;
const GOAL_TRAILER_RE = /\s*(?:Constraints|Previous progress|Evidence|Expected output|Output format|Deliverables)\s*:/i;
const LABELED_TITLE_RE = /^(?:目标|任务|标题|主题|工单|Objective|Task|Title|Subject)\s*[:：]\s*(.+)$/im;
const SCHEMA_TRAILER_RE = /(?:严格只返回|请严格只返回|仅返回|只返回单个\s*JSON|必须返回\s*JSON|返回\s*JSON\s*对象|输出格式\s*[:：]|return\s+only\s+(?:a\s+)?(?:valid\s+)?json|strictly\s+return\s+json|```json|\{\s*"[a-zA-Z_])/i;

function normalizeLines(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: `${text.slice(0, max - 1).trimEnd()}…`, clipped: true };
}

function stripLeadingWrappers(input: string): { text: string; stripped: boolean } {
  let current = input.trim();
  let stripped = false;
  for (let pass = 0; pass < 3; pass++) {
    const next = applyWrapperPass(current);
    if (next === current) break;
    current = next;
    stripped = true;
  }
  return { text: current, stripped };
}

function applyWrapperPass(text: string): string {
  for (const pattern of LEADING_WRAPPERS) {
    const next = text.replace(pattern, '').trim();
    if (next !== text) return next;
  }
  return text;
}

function stripGoalContinuation(input: string): { text: string; stripped: boolean } {
  const match = GOAL_CONTINUE_RE.exec(input);
  if (!match) return { text: input, stripped: false };
  const objective = match[1].split(GOAL_TRAILER_RE)[0]?.trim() ?? '';
  return { text: objective || input, stripped: true };
}

function stripSchemaPrompt(input: string): { text: string; stripped: boolean } {
  const match = SCHEMA_TRAILER_RE.exec(input);
  if (!match || match.index === undefined) return { text: input, stripped: false };
  const head = input.slice(0, match.index).replace(/[，,。;；:\s]+$/, '').trim();
  if (!head) return { text: input, stripped: false };
  return { text: head, stripped: true };
}

function pickLabeledLine(input: string): { text: string; stripped: boolean } {
  if (!input.includes('\n')) return { text: input, stripped: false };
  const match = LABELED_TITLE_RE.exec(input);
  if (!match) return { text: input, stripped: false };
  return { text: match[1].trim(), stripped: true };
}

function stripMarkdownLine(line: string): string {
  return collapseSpaces(
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/[*`~]+/g, '')
      .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
  );
}

function firstMeaningfulLine(text: string): string {
  for (const rawLine of text.split('\n')) {
    const cleaned = stripMarkdownLine(rawLine);
    if (cleaned) return cleaned;
  }
  return '';
}

function lookupBotName(map: BotNameLookup, botId: string): string {
  if (map instanceof Map) return map.get(botId) ?? '';
  return (map as Readonly<Record<string, string>>)[botId] ?? '';
}

function isDeliveryRejected(task: Pick<BotTaskItem, 'delivery' | 'deliveryReview'>): boolean {
  if (task.deliveryReview?.accepted === false) return true;
  return task.delivery?.manualReview?.accepted === false;
}

type TransformResult = { text: string; stripped: boolean };

const TITLE_TRANSFORMS: ReadonlyArray<(input: string) => TransformResult> = [
  stripLeadingWrappers,
  stripGoalContinuation,
  pickLabeledLine,
  stripSchemaPrompt,
];

function applyTitleTransforms(input: string): TransformResult {
  let current = input;
  let stripped = false;
  for (const transform of TITLE_TRANSFORMS) {
    const step = transform(current);
    current = step.text;
    if (step.stripped) stripped = true;
  }
  return { text: current, stripped };
}

/**
 * Strips internal goal/prompt/JSON-schema boilerplate into a concise single-line title.
 * Plain short task inputs are returned unchanged with `isExtracted: false`.
 */
export function extractBotTaskTitle(
  rawInput: string,
  fallback: string
): { title: string; isExtracted: boolean } {
  const normalized = normalizeLines(rawInput);
  if (!normalized) return { title: fallback, isExtracted: false };

  const cleaned = applyTitleTransforms(normalized);
  const singleLine = firstMeaningfulLine(cleaned.text) || collapseSpaces(cleaned.text);
  const clipped = clipText(singleLine, MAX_TITLE_CHARS);
  const isExtracted = [cleaned.stripped, clipped.clipped, normalized.includes('\n')].some(Boolean);
  return { title: clipped.text || fallback, isExtracted };
}

const JSON_PREVIEW_KEYS = ['reason', 'summary', 'message', 'detail', 'error', 'verdict'] as const;
const JSON_FIELD_FALLBACK_RE = /"(?:reason|summary|message|detail|error)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)/;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickJsonTextField(parsed: Record<string, unknown>): string {
  for (const key of JSON_PREVIEW_KEYS) {
    const val = parsed[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonPreview(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return '';
  const parsed = tryParseJsonObject(trimmed);
  if (parsed) return pickJsonTextField(parsed);
  const match = JSON_FIELD_FALLBACK_RE.exec(trimmed);
  return match ? match[1].replace(/\\"/g, '"').trim() : '';
}

function extractTextSnippet(raw: string): string {
  const jsonText = extractJsonPreview(raw);
  if (jsonText) return collapseSpaces(jsonText);
  return firstMeaningfulLine(raw);
}

function extractValuePreview(value: unknown): string {
  if (typeof value === 'string') return extractTextSnippet(value);
  if (isPlainRecord(value)) return collapseSpaces(pickJsonTextField(value));
  return '';
}

function secondaryInputLine(rawInput: string): string {
  const lines = normalizeLines(rawInput).split('\n').map(stripMarkdownLine).filter(Boolean);
  if (lines.length < 2) return '';
  const candidate = lines[1];
  return SCHEMA_TRAILER_RE.test(candidate) ? '' : candidate;
}

function previewCandidates(
  task: Pick<BotTaskItem, 'input' | 'failureReason' | 'result' | 'resultSummary' | 'delivery'>
): string[] {
  return [
    extractTextSnippet(asText(task.failureReason)),
    extractTextSnippet(asText(task.delivery?.summary)),
    extractTextSnippet(asText(task.resultSummary)),
    extractTextSnippet(asText(task.delivery?.report)),
    extractValuePreview(task.result),
    secondaryInputLine(task.input),
  ];
}

/**
 * Produces a concise one-line outcome or secondary preview that never duplicates `cleanTitle`.
 */
export function extractBotTaskPreview(
  task: Pick<BotTaskItem, 'input' | 'failureReason' | 'result' | 'resultSummary' | 'delivery'>,
  cleanTitle: string
): string {
  const normalizedTitle = collapseSpaces(cleanTitle).toLowerCase();
  for (const raw of previewCandidates(task)) {
    const cleaned = collapseSpaces(raw);
    if (!cleaned || cleaned.toLowerCase() === normalizedTitle) continue;
    return clipText(cleaned, MAX_PREVIEW_CHARS).text;
  }
  return '';
}

export function extractCollaborationTitle(goal: string, fallback: string): string {
  return extractBotTaskTitle(goal, fallback).title;
}

export function extractCollaborationPreview(summary?: string): string {
  if (!summary) return '';
  const line = extractTextSnippet(summary);
  return line ? clipText(line, MAX_PREVIEW_CHARS).text : '';
}

export function isUnresolvedBotTask(task: Pick<BotTaskItem, 'status'>): boolean {
  return UNRESOLVED_STATUSES.has(task.status);
}

export function classifyBotTaskBand(
  task: Pick<BotTaskItem, 'status' | 'delivery' | 'deliveryReview'>
): BotTaskBand {
  if (ATTENTION_STATUSES.has(task.status) || isDeliveryRejected(task)) return 'attention';
  if (ACTIVE_STATUSES.has(task.status)) return 'active';
  return 'history';
}

function taskTimestampMs(task: Pick<BotTaskItem, 'updatedAt' | 'createdAt'>): number {
  const iso = task.updatedAt ?? task.createdAt;
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

function matchesTimeRange(
  task: Pick<BotTaskItem, 'updatedAt' | 'createdAt'>,
  range: BotTaskTimeRange,
  nowMs: number
): boolean {
  if (range === 'all') return true;
  const ts = taskTimestampMs(task);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= TIME_RANGE_MS[range];
}

function matchesBotTaskQuery(
  task: BotTaskItem,
  needle: string,
  botNameMap: BotNameLookup
): boolean {
  if (!needle) return true;
  const fields = [
    task.id,
    task.input,
    task.failureReason,
    task.targetBotId,
    lookupBotName(botNameMap, task.targetBotId),
    task.resultSummary,
    task.delivery?.summary,
  ];
  return fields.some((part) => typeof part === 'string' && part.toLowerCase().includes(needle));
}

function matchesBandFilter(task: BotTaskItem, band: 'all' | BotTaskBand): boolean {
  return band === 'all' || classifyBotTaskBand(task) === band;
}

function matchesBotFilter(task: BotTaskItem, botId: string): boolean {
  return !botId || task.targetBotId === botId;
}

export function filterBotTasks<T extends BotTaskItem>(
  tasks: readonly T[],
  filters: BotTaskFilterState,
  botNameMap: BotNameLookup,
  nowMs: number = Date.now()
): T[] {
  const needle = filters.query.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      matchesBandFilter(task, filters.band) &&
      matchesBotFilter(task, filters.botId) &&
      matchesTimeRange(task, filters.timeRange, nowMs) &&
      matchesBotTaskQuery(task, needle, botNameMap)
  );
}

export function countBotTaskFacets(
  tasks: readonly BotTaskItem[],
  _botNameMap: BotNameLookup,
  nowMs: number = Date.now()
): BotTaskFacetCounts {
  const byBand: Record<BotTaskBand, number> = { attention: 0, active: 0, history: 0 };
  const byBot: Record<string, number> = {};
  const byTime: Record<BotTaskTimeRange, number> = { all: tasks.length, today: 0, '3d': 0, '7d': 0 };

  for (const task of tasks) {
    byBand[classifyBotTaskBand(task)] += 1;
    byBot[task.targetBotId] = (byBot[task.targetBotId] ?? 0) + 1;
    incrementTimeCounts(task, byTime, nowMs);
  }
  return { total: tasks.length, byBand, byBot, byTime };
}

function incrementTimeCounts(
  task: Pick<BotTaskItem, 'updatedAt' | 'createdAt'>,
  byTime: Record<BotTaskTimeRange, number>,
  nowMs: number
): void {
  if (matchesTimeRange(task, 'today', nowMs)) byTime.today += 1;
  if (matchesTimeRange(task, '3d', nowMs)) byTime['3d'] += 1;
  if (matchesTimeRange(task, '7d', nowMs)) byTime['7d'] += 1;
}

export function groupBotTasksByBand<T extends BotTaskItem>(
  tasks: readonly T[]
): Record<BotTaskBand, T[]> {
  const grouped: Record<BotTaskBand, T[]> = { attention: [], active: [], history: [] };
  for (const task of tasks) {
    grouped[classifyBotTaskBand(task)].push(task);
  }
  return grouped;
}

function hasMemberInBand(members: readonly BotTaskItem[], band: BotTaskBand): boolean {
  return members.some((member) => classifyBotTaskBand(member) === band);
}

function isAttentionCollaboration(
  group: Pick<BotCollaborationGroup, 'status' | 'blockers' | 'members'>
): boolean {
  if (group.status === 'blocked' || group.blockers.length > 0) return true;
  return hasMemberInBand(group.members, 'attention');
}

export function classifyCollaborationBand(
  group: Pick<BotCollaborationGroup, 'status' | 'blockers' | 'members'>
): BotTaskBand {
  if (isAttentionCollaboration(group)) return 'attention';
  if (ACTIVE_STATUSES.has(group.status) || hasMemberInBand(group.members, 'active')) return 'active';
  return 'history';
}

function matchesCollaborationQuery(
  group: BotCollaborationGroup,
  needle: string,
  botNameMap: BotNameLookup
): boolean {
  if (!needle) return true;
  if (group.goal.toLowerCase().includes(needle)) return true;
  return group.members.some((member) => matchesBotTaskQuery(member, needle, botNameMap));
}

function matchesCollaborationBot(group: BotCollaborationGroup, botId: string): boolean {
  if (!botId) return true;
  return group.members.some((member) => member.targetBotId === botId);
}

function matchesCollaborationBand(group: BotCollaborationGroup, band: 'all' | BotTaskBand): boolean {
  return band === 'all' || classifyCollaborationBand(group) === band;
}

function matchesCollaborationTime(
  group: BotCollaborationGroup,
  range: BotTaskTimeRange,
  nowMs: number
): boolean {
  if (range === 'all') return true;
  return group.members.some((member) => matchesTimeRange(member, range, nowMs));
}

export function filterCollaborations(
  groups: readonly BotCollaborationGroup[],
  filters: BotTaskFilterState,
  botNameMap: BotNameLookup,
  nowMs: number = Date.now()
): BotCollaborationGroup[] {
  const needle = filters.query.trim().toLowerCase();
  return groups.filter(
    (group) =>
      matchesCollaborationBand(group, filters.band) &&
      matchesCollaborationBot(group, filters.botId) &&
      matchesCollaborationTime(group, filters.timeRange, nowMs) &&
      matchesCollaborationQuery(group, needle, botNameMap)
  );
}

export interface BotTaskPagePayload<T extends { id: string; status: string } = BotTaskItem> {
  tasks?: T[];
  activeTasks: T[];
  historyTasks: T[];
}

export interface MergeBotTasksOptions<T extends { id: string; status: string } = BotTaskItem> {
  extend?: boolean;
  resolvedFinished?: readonly T[];
}

/**
 * Returns IDs of previously unresolved tasks that disappeared from incoming `activeTasks`
 * and are not already present in `historyTasks`, so callers can fetch their terminal states.
 */
export function findDroppedUnresolvedIds<T extends { id: string; status: string }>(
  previous: readonly T[],
  incoming: Pick<BotTaskPagePayload<T>, 'activeTasks' | 'historyTasks'>
): string[] {
  const knownIds = new Set([
    ...incoming.activeTasks.map((t) => t.id),
    ...incoming.historyTasks.map((t) => t.id),
  ]);
  return previous
    .filter((t) => isUnresolvedBotTask(t) && !knownIds.has(t.id))
    .map((t) => t.id);
}

function mergePagedBotTasks<T extends { id: string; status: string }>(
  incoming: BotTaskPagePayload<T>,
  previous: readonly T[],
  options: MergeBotTasksOptions<T>
): T[] {
  const activeIds = new Set(incoming.activeTasks.map((t) => t.id));
  const previousIds = new Set(previous.map((t) => t.id));
  const extend = Boolean(options.extend);
  const retained = previous.filter((t) => !isUnresolvedBotTask(t) && !activeIds.has(t.id));
  const history = incoming.historyTasks.filter((t) => extend || previousIds.has(t.id));
  const finished = options.resolvedFinished ?? [];
  const merged = new Map<string, T>();
  for (const item of [...retained, ...history, ...finished, ...incoming.activeTasks]) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

/**
 * Pure merge helper for polled or paginated `/api/bot-work/tasks` snapshots.
 * Preserves previously loaded older history when `paged` is true.
 */
export function mergePolledBotTasks<T extends { id: string; status: string }>(
  incoming: BotTaskPagePayload<T>,
  previous: readonly T[],
  paged: boolean,
  options: MergeBotTasksOptions<T> = {}
): T[] {
  if (!paged && !options.extend) {
    return incoming.tasks ?? [...incoming.activeTasks, ...incoming.historyTasks];
  }
  return mergePagedBotTasks(incoming, previous, options);
}

function formatShortDate(ts: number, nowMs: number): string {
  const date = new Date(ts);
  const now = new Date(nowMs);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  if (date.getFullYear() === now.getFullYear()) return `${mm}-${dd}`;
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export interface RelativeTimeLabels {
  justNow: string;
  minutesAgo: (count: number) => string;
  hoursAgo: (count: number) => string;
  daysAgo: (count: number) => string;
}

export type RelativeTimeTranslator = (
  key: 'botWork.timeJustNow' | 'botWork.timeMinutesAgo' | 'botWork.timeHoursAgo' | 'botWork.timeDaysAgo',
  vars?: { count: number }
) => string;

export function relativeTimeLabelsFrom(t: RelativeTimeTranslator): RelativeTimeLabels {
  return {
    justNow: t('botWork.timeJustNow'),
    minutesAgo: (count) => t('botWork.timeMinutesAgo', { count }),
    hoursAgo: (count) => t('botWork.timeHoursAgo', { count }),
    daysAgo: (count) => t('botWork.timeDaysAgo', { count }),
  };
}

const DEFAULT_ZH_TIME_LABELS: RelativeTimeLabels = {
  justNow: '刚刚',
  minutesAgo: (count) => `${count} 分钟前`,
  hoursAgo: (count) => `${count} 小时前`,
  daysAgo: (count) => `${count} 天前`,
};

const DEFAULT_EN_TIME_LABELS: RelativeTimeLabels = {
  justNow: 'Just now',
  minutesAgo: (count) => `${count}m ago`,
  hoursAgo: (count) => `${count}h ago`,
  daysAgo: (count) => `${count}d ago`,
};

function resolveTimeLabels(locale: string, labels?: RelativeTimeLabels): RelativeTimeLabels {
  if (labels) return labels;
  return locale.toLowerCase().startsWith('en') ? DEFAULT_EN_TIME_LABELS : DEFAULT_ZH_TIME_LABELS;
}

function formatDaysOrDate(
  days: number,
  ts: number,
  nowMs: number,
  labels: RelativeTimeLabels
): string {
  return days < 7 ? labels.daysAgo(days) : formatShortDate(ts, nowMs);
}

function formatRelativeDelta(
  diffSec: number,
  ts: number,
  nowMs: number,
  labels: RelativeTimeLabels
): string {
  if (diffSec < 60) return labels.justNow;
  if (diffSec < 3600) return labels.minutesAgo(Math.floor(diffSec / 60));
  if (diffSec < 86400) return labels.hoursAgo(Math.floor(diffSec / 3600));
  return formatDaysOrDate(Math.floor(diffSec / 86400), ts, nowMs, labels);
}

export function formatRelativeTime(
  iso: string | undefined,
  locale: 'zh' | 'en' | string,
  nowMs: number = Date.now(),
  labels?: RelativeTimeLabels
): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  return formatRelativeDelta(diffSec, ts, nowMs, resolveTimeLabels(locale, labels));
}

const CJK_START_RE = /^[\u3400-\u9fff\uf900-\ufaff]/;

export function getBotInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  if (CJK_START_RE.test(clean)) return clean.slice(0, 1);
  const words = clean.split(/[\s_\-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

function stepFromIndex(ids: readonly string[], index: number, delta: -1 | 1): string | null {
  if (index < 0) return ids[0];
  const nextIndex = index + delta;
  return nextIndex >= 0 && nextIndex < ids.length ? ids[nextIndex] : null;
}

export function stepItemId(
  ids: readonly string[],
  currentId: string | null,
  delta: -1 | 1
): string | null {
  if (ids.length === 0) return null;
  if (!currentId) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return stepFromIndex(ids, ids.indexOf(currentId), delta);
}

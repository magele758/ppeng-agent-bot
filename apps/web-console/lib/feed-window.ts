import { mergeHistoryWindow } from './history-window.ts';

/** How many transcript rows the Lab asks for per page. A few dozen, not the whole session. */
export const PLAY_FEED_PAGE_SIZE = 40;

export const FEED_ROW_ESTIMATE_PX = 96;
export const FEED_OVERSCAN_PX = 480;
export const FEED_FALLBACK_ROWS = 24;
export const FEED_NEAR_TOP_PX = 64;

export type FeedSlotKind = 'message' | 'approval' | 'stats' | 'optimistic' | 'stream' | 'typing' | 'trail';

export interface FeedSlot {
  key: string;
  pin?: boolean;
  kind: FeedSlotKind;
  messageIndex?: number;
  turnIndex?: number;
}

export interface FeedRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

export type FeedScrollIntent =
  | { kind: 'bottom' }
  | { kind: 'pin'; top: number; key?: string; offset?: number }
  | { kind: 'prepend'; top: number; height: number; key?: string; offset?: number };

export interface FeedTurnSlot {
  endIndex: number;
  turnIndex: number;
  stats: boolean;
  live: boolean;
}

/** Query string for the Lab transcript. Always bounded; `beforeSeq` asks for the previous page. */
export function sessionFeedSearch(beforeSeq?: number | null): string {
  const params = new URLSearchParams({ messageLimit: String(PLAY_FEED_PAGE_SIZE) });
  if (beforeSeq != null) params.set('beforeSeq', String(beforeSeq));
  return params.toString();
}

/**
 * Streaming tokens update the local overlay. They must not trigger a transcript refetch.
 * A later refresh, if one happens, still uses {@link sessionFeedSearch}.
 */
export function streamEventNeedsTranscriptRefetch(_event: string, _type?: string): boolean {
  return false;
}

export function feedMessageKey(message: { id?: unknown }, index: number): string {
  return typeof message.id === 'string' && message.id ? message.id : `#${index}`;
}

export function buildFeedSlots(args: {
  messages: Array<{ id?: string }>;
  turns: FeedTurnSlot[];
  approvalIndexes: number[];
  optimistic: boolean;
  stream: boolean;
  streamApproval: boolean;
  typing: boolean;
  trail: boolean;
}): FeedSlot[] {
  const slots: FeedSlot[] = [];
  const turnByEnd = new Map(args.turns.map((turn) => [turn.endIndex, turn]));
  const approvals = new Set(args.approvalIndexes);
  for (let index = 0; index < args.messages.length; index += 1) {
    const id = feedMessageKey(args.messages[index] ?? {}, index);
    slots.push({ key: `m:${id}`, kind: 'message', messageIndex: index });
    if (approvals.has(index)) slots.push({ key: `apr:${id}`, kind: 'approval', messageIndex: index });
    const turn = turnByEnd.get(index);
    if (turn?.stats) {
      slots.push({
        key: `stats:${id}`,
        kind: 'stats',
        turnIndex: turn.turnIndex,
        pin: turn.live || undefined
      });
    }
  }
  if (args.optimistic) slots.push({ key: 'optimistic', kind: 'optimistic', pin: true });
  if (args.stream) slots.push({ key: 'stream', kind: 'stream', pin: true });
  if (args.streamApproval) slots.push({ key: 'apr-stream', kind: 'approval', pin: true });
  if (args.typing) slots.push({ key: 'typing', kind: 'typing', pin: true });
  if (args.trail) slots.push({ key: 'apr-trail', kind: 'trail', pin: true });
  return slots;
}

/** Pinned live rows (stream, typing, jump-to-tail stats) stay mounted. They must be a suffix. */
export function splitPinnedSuffix<T extends { pin?: boolean }>(slots: T[]): { history: T[]; pinned: T[] } {
  let index = slots.length;
  while (index > 0 && slots[index - 1]?.pin) index -= 1;
  return { history: slots.slice(0, index), pinned: slots.slice(index) };
}

export function prefixHeights(count: number, heightAt: (index: number) => number): number[] {
  const prefix = new Array<number>(count + 1);
  prefix[0] = 0;
  for (let index = 0; index < count; index += 1) {
    prefix[index + 1] = prefix[index]! + heightAt(index);
  }
  return prefix;
}

export function historyWindow(options: {
  count: number;
  scrollTop: number;
  viewport: number;
  prefix: number[];
  overscanPx?: number;
  stickToBottom: boolean;
  fallbackRows?: number;
}): FeedRange {
  const count = options.count;
  const overscan = options.overscanPx ?? FEED_OVERSCAN_PX;
  const fallback = options.fallbackRows ?? FEED_FALLBACK_ROWS;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const total = options.prefix[count] ?? 0;
  const viewport = options.viewport;
  if (viewport <= 0) {
    if (options.stickToBottom) {
      const start = Math.max(0, count - fallback);
      return { start, end: count, padTop: options.prefix[start] ?? 0, padBottom: 0 };
    }
    const end = Math.min(count, fallback);
    return { start: 0, end, padTop: 0, padBottom: total - (options.prefix[end] ?? 0) };
  }
  const scrollTop = options.stickToBottom
    ? Math.max(0, total - viewport)
    : Math.max(0, options.scrollTop);
  const from = Math.max(0, scrollTop - overscan);
  const to = scrollTop + viewport + overscan;
  let start = 0;
  while (start < count && (options.prefix[start + 1] ?? 0) <= from) start += 1;
  let end = start;
  while (end < count && (options.prefix[end] ?? 0) < to) end += 1;
  if (options.stickToBottom) end = count;
  return {
    start,
    end,
    padTop: options.prefix[start] ?? 0,
    padBottom: total - (options.prefix[end] ?? 0)
  };
}

/** Keep a row inside the mounted window so scroll restoration can see it. */
export function feedRange(
  history: Array<{ key: string }>,
  scrollTop: number,
  viewport: number,
  prefix: number[],
  stickToBottom: boolean,
  intent: FeedScrollIntent | null
): FeedRange {
  const focusKey = intent && intent.kind !== 'bottom' ? intent.key : undefined;
  const focusIndex = focusKey ? history.findIndex((slot) => slot.key === focusKey) : -1;
  const range = historyWindow({
    count: history.length,
    scrollTop,
    viewport,
    prefix,
    stickToBottom,
    fallbackRows: FEED_FALLBACK_ROWS
  });
  if (focusIndex < 0) return range;
  return rangeIncluding(range, focusIndex, history.length, prefix);
}

export function rememberRowHeight(input: {
  heights: Map<string, number>;
  history: Array<{ key: string }>;
  prefix: number[];
  key: string;
  height: number;
  scrollTop: number;
  stick: boolean;
  pending: boolean;
}): { changed: boolean; shift: number } {
  const previous = input.heights.get(input.key) ?? FEED_ROW_ESTIMATE_PX;
  if (Math.abs(previous - input.height) < 1) {
    input.heights.set(input.key, input.height);
    return { changed: false, shift: 0 };
  }
  const index = input.history.findIndex((slot) => slot.key === input.key);
  const shift = heightScrollShift({
    index,
    previous,
    next: input.height,
    rowTop: input.prefix[index] ?? 0,
    scrollTop: input.scrollTop,
    stick: input.stick,
    pending: input.pending
  });
  input.heights.set(input.key, input.height);
  return { changed: true, shift };
}

export function rangeIncluding(range: FeedRange, index: number, count: number, prefix: number[]): FeedRange {
  if (index < 0 || index >= count || (index >= range.start && index < range.end)) return range;
  const span = Math.max(range.end - range.start, 8);
  const start = Math.max(0, Math.min(index, count - span));
  const end = Math.min(count, Math.max(index + 1, start + span));
  const total = prefix[count] ?? 0;
  return {
    start,
    end,
    padTop: prefix[start] ?? 0,
    padBottom: total - (prefix[end] ?? 0)
  };
}

/** Same clamp the session list uses when a refresh replaces rows. */
export function preservedScrollTop(top: number, scrollHeight: number, clientHeight: number): number {
  return Math.min(Math.max(0, top), Math.max(0, scrollHeight - clientHeight));
}

export function scrollTopAfterPrepend(top: number, previousHeight: number, nextHeight: number): number {
  return Math.max(0, top + (nextHeight - previousHeight));
}

/** Move scrollTop so a row that sits at `currentOffset` returns to `targetOffset`. */
export function scrollTopToAnchor(currentScrollTop: number, currentOffset: number, targetOffset: number): number {
  return currentScrollTop + (currentOffset - targetOffset);
}

export function nextTranscriptWindow<T extends { id: string; seq?: number }>(input: {
  sameSession: boolean;
  previous: T[];
  incoming: T[];
  hasMore: boolean;
  nextCursor: number | null;
  previousCursor: number | null;
  stick: boolean;
  anchor: { key?: string; offset?: number; top: number; height: number };
}): { messages: T[]; cursor: number | null; stick: boolean; intent: FeedScrollIntent } {
  const merged = mergeHistoryWindow(input.previous, input.incoming, input.sameSession);
  const followTail = merged.reset || input.stick;
  const planned = planFeedScroll(followTail ? 'bottom' : 'pin', followTail, input.anchor);
  const cursor = merged.reset ? (input.hasMore ? input.nextCursor : null) : input.previousCursor;
  return { messages: merged.messages, cursor, stick: planned.stick, intent: planned.intent };
}

export function canRequestOlderPage(input: {
  sessionId: string | null;
  cursor: number | null;
  loading: boolean;
  reason: 'scroll' | 'auto';
  blocked: boolean;
}): boolean {
  if (!input.sessionId || input.cursor == null || input.loading) return false;
  if (input.reason === 'auto' && input.blocked) return false;
  return true;
}

export function showLatestWhenStuck(stick: boolean, show: (value: boolean) => void): void {
  if (stick) show(false);
}

export function pageEpochCurrent(currentSession: string | null, sessionId: string, epochNow: number, epochThen: number): boolean {
  return currentSession === sessionId && epochNow === epochThen;
}

export interface ScrollTarget {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  querySelector: (selector: string) => { getBoundingClientRect: () => { top: number } } | null;
  getBoundingClientRect: () => { top: number };
}

/** Align the scroller to a pending intent. Returns the next intent (kept while row heights settle). */
export function resolveFeedScroll(el: ScrollTarget, pending: FeedScrollIntent | null, tries: number): {
  intent: FeedScrollIntent | null;
  tries: number;
  scrollTop: number | null;
} {
  if (!pending) return { intent: null, tries, scrollTop: null };
  if (pending.kind === 'bottom') {
    return { intent: null, tries: 0, scrollTop: Math.max(0, el.scrollHeight - el.clientHeight) };
  }
  const nextTries = tries + 1;
  const node = pending.key != null ? el.querySelector(`[data-feed-key="${cssEscape(pending.key)}"]`) : null;
  if (node && pending.offset != null) {
    const current = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const done = Math.abs(current - pending.offset) <= 1 || nextTries > 4;
    return {
      intent: done ? null : pending,
      tries: done ? 0 : nextTries,
      scrollTop: preservedScrollTop(scrollTopToAnchor(el.scrollTop, current, pending.offset), el.scrollHeight, el.clientHeight)
    };
  }
  if (pending.kind === 'prepend') {
    return {
      intent: null,
      tries: 0,
      scrollTop: preservedScrollTop(scrollTopAfterPrepend(pending.top, pending.height, el.scrollHeight), el.scrollHeight, el.clientHeight)
    };
  }
  return {
    intent: null,
    tries: 0,
    scrollTop: preservedScrollTop(pending.top, el.scrollHeight, el.clientHeight)
  };
}

export function heightScrollShift(input: {
  index: number;
  previous: number;
  next: number;
  rowTop: number;
  scrollTop: number;
  stick: boolean;
  pending: boolean;
}): number {
  if (input.pending || input.stick || input.index < 0) return 0;
  const rowBottom = input.rowTop + input.previous;
  if (rowBottom > input.scrollTop + 1) return 0;
  return input.next - input.previous;
}

export function shouldAutoLoadOlder(hasOlder: boolean, loading: boolean, scrollHeight: number, clientHeight: number): boolean {
  // clientHeight 0 means the scroller has not laid out yet; treating that as
  // "short content" would auto-fetch every older page on open and clear the cursor.
  if (clientHeight <= 0) return false;
  return hasOlder && !loading && scrollHeight <= clientHeight + 1;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function planFeedScroll(
  kind: 'bottom' | 'pin' | 'prepend',
  stickToBottom: boolean,
  anchor: { key?: string; offset?: number; top: number; height: number }
): { stick: boolean; intent: FeedScrollIntent } {
  if (kind === 'bottom' || stickToBottom) return { stick: true, intent: { kind: 'bottom' } };
  if (kind === 'prepend') {
    return {
      stick: false,
      intent: { kind: 'prepend', top: anchor.top, height: anchor.height, key: anchor.key, offset: anchor.offset }
    };
  }
  return { stick: false, intent: { kind: 'pin', top: anchor.top, key: anchor.key, offset: anchor.offset } };
}

export function readFeedAnchor(root: HTMLElement | null): { key?: string; offset?: number; top: number; height: number } {
  if (!root) return { top: 0, height: 0 };
  const anchor = captureFeedAnchor(root);
  return {
    top: root.scrollTop,
    height: root.scrollHeight,
    key: anchor?.key,
    offset: anchor?.offset
  };
}

export function captureFeedAnchor(root: HTMLElement): { key: string; offset: number } | null {
  const rootBox = root.getBoundingClientRect();
  const rows = root.querySelectorAll<HTMLElement>('[data-feed-key]');
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (box.bottom <= rootBox.top + 1) continue;
    const key = row.dataset.feedKey ?? '';
    if (!key) continue;
    return { key, offset: box.top - rootBox.top };
  }
  return null;
}

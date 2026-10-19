import test from 'node:test';
import assert from 'node:assert/strict';
import { prependHistoryPage } from './history-window.ts';
import {
  FEED_ROW_ESTIMATE_PX,
  canRequestOlderPage,
  feedRange,
  historyWindow,
  nextTranscriptWindow,
  planFeedScroll,
  prefixHeights,
  preservedScrollTop,
  rangeIncluding,
  resolveFeedScroll,
  scrollTopAfterPrepend,
  scrollTopToAnchor,
  sessionFeedSearch,
  splitPinnedSuffix,
  streamEventNeedsTranscriptRefetch,
  buildFeedSlots,
  heightScrollShift,
  shouldAutoLoadOlder
} from './feed-window.ts';

const page = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ id: `m${from + index}`, seq: from + index }));

test('opening and refreshing a session requests one bounded page [AC:play-feed-window#AC-1] [AC:play-feed-window#AC-4]', () => {
  const open = new URLSearchParams(sessionFeedSearch());
  assert.equal(open.get('messageLimit'), '40');
  assert.equal(open.has('beforeSeq'), false);
  const older = new URLSearchParams(sessionFeedSearch(80));
  assert.equal(older.get('messageLimit'), '40');
  assert.equal(older.get('beforeSeq'), '80');
  assert.equal(streamEventNeedsTranscriptRefetch('model', 'text_delta'), false);
  assert.equal(streamEventNeedsTranscriptRefetch('model', 'reasoning_delta'), false);
  assert.equal(streamEventNeedsTranscriptRefetch('model', 'tool_call_delta'), false);
});

test('the page before the newest page stitches without overlap or a duplicate edge [AC:play-feed-window#AC-2]', () => {
  const newest = page(71, 100);
  const previous = page(41, 70);
  const stitched = prependHistoryPage(newest, previous);
  assert.deepEqual(stitched.map((message) => message.seq), page(41, 100).map((message) => message.seq));
  assert.equal(new Set(stitched.map((message) => message.id)).size, stitched.length);
  const overlapped = prependHistoryPage(newest, [...previous, { id: 'm71', seq: 71, text: 'stale' }]);
  assert.equal(overlapped.filter((message) => message.id === 'm71').length, 1);
  assert.equal('text' in overlapped.find((message) => message.id === 'm71')!, false);
  assert.equal(scrollTopAfterPrepend(24, 400, 900), 524);
  assert.equal(scrollTopToAnchor(120, 80, 16), 184);
});

test('a short transcript stays fully mounted when the bubbles are taller than the viewport', () => {
  const count = 9;
  const prefix = prefixHeights(count, () => 800);
  const stuck = historyWindow({
    count,
    scrollTop: 0,
    viewport: 437,
    prefix,
    stickToBottom: true,
    overscanPx: 480
  });
  assert.equal(stuck.start, 0);
  assert.equal(stuck.end, count);
  assert.equal(stuck.padTop, 0);
  assert.equal(stuck.padBottom, 0);
  const parked = historyWindow({
    count,
    scrollTop: 0,
    viewport: 437,
    prefix,
    stickToBottom: false,
    overscanPx: 0
  });
  assert.equal(parked.start, 0);
  assert.equal(parked.end, count);
});

test('loaded rows stay windowed and the tail stays mounted while following the bottom [AC:play-feed-window#AC-3]', () => {
  const count = 200;
  const prefix = prefixHeights(count, () => FEED_ROW_ESTIMATE_PX);
  const middle = historyWindow({
    count,
    scrollTop: 8000,
    viewport: 640,
    prefix,
    stickToBottom: false,
    overscanPx: 200
  });
  assert.ok(middle.end - middle.start < count);
  assert.ok(middle.end - middle.start < 40);
  assert.equal(middle.padTop + (middle.end - middle.start) * FEED_ROW_ESTIMATE_PX + middle.padBottom, prefix[count]);
  const tail = historyWindow({
    count,
    scrollTop: 0,
    viewport: 640,
    prefix,
    stickToBottom: true,
    overscanPx: 0
  });
  assert.equal(tail.end, count);
  assert.ok(tail.start > count - 40);
  const slots = buildFeedSlots({
    messages: page(1, 80),
    turns: [],
    approvalIndexes: [],
    optimistic: false,
    stream: true,
    streamApproval: false,
    typing: false,
    trail: false
  });
  const split = splitPinnedSuffix(slots);
  assert.equal(split.history.length, 80);
  assert.deepEqual(split.pinned.map((slot) => slot.kind), ['stream']);
});

test('scroll intent keeps an anchor row and a short page can auto-load [AC:play-feed-window#AC-2] [AC:play-feed-window#AC-5]', () => {
  const anchor = { top: 12, height: 400, key: 'm:1', offset: 20 };
  const el = {
    scrollHeight: 900,
    clientHeight: 200,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 80 }) })
  };
  const moved = resolveFeedScroll(el, { kind: 'prepend', top: 0, height: 400, key: 'm:1', offset: 20 }, 0);
  assert.equal(moved.scrollTop, 60);
  assert.equal(moved.intent?.kind, 'prepend');
  el.scrollTop = 60;
  el.querySelector = () => ({ getBoundingClientRect: () => ({ top: 20 }) });
  assert.equal(resolveFeedScroll(el, moved.intent, moved.tries).intent, null);
  const bottom = resolveFeedScroll({ ...el, scrollHeight: 500 }, { kind: 'bottom' }, 0);
  assert.equal(bottom.scrollTop, 300);
  const pinned = resolveFeedScroll({ ...el, querySelector: () => null }, { kind: 'pin', top: 40 }, 0);
  assert.equal(pinned.scrollTop, 40);
  const planned = nextTranscriptWindow({
    sameSession: true,
    previous: page(1, 40),
    incoming: page(20, 50),
    hasMore: true,
    nextCursor: 20,
    previousCursor: 1,
    stick: false,
    anchor
  });
  assert.equal(planned.cursor, 1);
  assert.equal(planned.stick, false);
  assert.equal(canRequestOlderPage({ sessionId: 's', cursor: 1, loading: false, reason: 'scroll', blocked: false }), true);
  assert.equal(canRequestOlderPage({ sessionId: null, cursor: 1, loading: false, reason: 'scroll', blocked: false }), false);
  assert.equal(canRequestOlderPage({ sessionId: 's', cursor: 1, loading: false, reason: 'auto', blocked: true }), false);
  assert.equal(resolveFeedScroll(el, null, 0).scrollTop, null);
  const fallback = resolveFeedScroll({ ...el, scrollTop: 4, querySelector: () => null }, { kind: 'prepend', top: 4, height: 10 }, 0);
  assert.equal(fallback.intent, null);
  assert.equal(typeof fallback.scrollTop, 'number');
  assert.equal(heightScrollShift({ index: 0, previous: 10, next: 30, rowTop: 0, scrollTop: 40, stick: false, pending: false }), 20);
  assert.equal(shouldAutoLoadOlder(true, false, 100, 200), true);
  assert.equal(shouldAutoLoadOlder(true, false, 0, 0), false);
  assert.equal(shouldAutoLoadOlder(true, false, 50, 0), false);
  const prefix = prefixHeights(10, () => 10);
  const widened = rangeIncluding({ start: 0, end: 2, padTop: 0, padBottom: 80 }, 8, 10, prefix);
  assert.ok(widened.start <= 8 && widened.end > 8);
  const ranged = feedRange([{ key: 'a' }, { key: 'b' }], 0, 0, prefixHeights(2, () => 10), true, { kind: 'pin', top: 0, key: 'b', offset: 0 });
  assert.equal(ranged.end, 2);
});

test('a refresh keeps the scroll offset unless the reader is already on the tail [AC:play-feed-window#AC-5]', () => {
  const anchor = { top: 480, height: 4000, key: 'm:12', offset: 20 };
  const pinned = planFeedScroll('pin', false, anchor);
  assert.equal(pinned.stick, false);
  assert.equal(pinned.intent.kind, 'pin');
  if (pinned.intent.kind === 'pin') assert.equal(pinned.intent.top, 480);
  const tail = planFeedScroll('pin', true, anchor);
  assert.equal(tail.stick, true);
  assert.equal(tail.intent.kind, 'bottom');
  assert.equal(preservedScrollTop(480, 500, 200), 300);
  assert.equal(preservedScrollTop(40, 500, 200), 40);
});

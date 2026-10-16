import test from 'node:test';
import assert from 'node:assert/strict';
import { prependHistoryPage } from './history-window.ts';
import {
  FEED_ROW_ESTIMATE_PX,
  historyWindow,
  planFeedScroll,
  prefixHeights,
  preservedScrollTop,
  scrollTopAfterPrepend,
  scrollTopToAnchor,
  sessionFeedSearch,
  splitPinnedSuffix,
  streamEventNeedsTranscriptRefetch,
  buildFeedSlots
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

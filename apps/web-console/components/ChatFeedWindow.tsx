'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent
} from 'react';
import {
  FEED_FALLBACK_ROWS,
  FEED_NEAR_TOP_PX,
  FEED_OVERSCAN_PX,
  FEED_ROW_ESTIMATE_PX,
  feedRange,
  historyWindow,
  prefixHeights,
  rememberRowHeight,
  resolveFeedScroll,
  shouldAutoLoadOlder,
  splitPinnedSuffix,
  type FeedRange,
  type FeedScrollIntent,
  type FeedSlot
} from '@/lib/feed-window';

function rangesEqual(left: FeedRange, right: FeedRange): boolean {
  return left.start === right.start && left.end === right.end && left.padTop === right.padTop && left.padBottom === right.padBottom;
}

function FeedRow({
  rowKey,
  onHeight,
  children
}: {
  rowKey: string;
  onHeight: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(rowKey, el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeight, rowKey]);
  return (
    <div ref={ref} data-feed-key={rowKey} className="chat-feed__row">
      {children}
    </div>
  );
}

export function ChatFeedWindow({
  layoutKey,
  scrollerRef,
  slots,
  renderSlot,
  stickToBottomRef,
  scrollIntentRef,
  revision,
  hasOlder,
  olderLoading,
  onStickScroll,
  onRequestOlder,
  header,
  footer
}: {
  layoutKey?: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  slots: FeedSlot[];
  renderSlot: (slot: FeedSlot) => ReactNode;
  stickToBottomRef: RefObject<boolean>;
  scrollIntentRef: RefObject<FeedScrollIntent | null>;
  revision: number;
  hasOlder: boolean;
  olderLoading: boolean;
  onStickScroll: () => void;
  onRequestOlder: (reason: 'scroll' | 'auto') => void;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const heightsRef = useRef(new Map<string, number>());
  const prefixRef = useRef<number[]>([0]);
  const onRequestOlderRef = useRef(onRequestOlder);
  onRequestOlderRef.current = onRequestOlder;
  const applyingScrollRef = useRef(false);
  const nearTopRef = useRef(false);
  const intentTriesRef = useRef(0);
  const [scrollPosition, setScrollPosition] = useState({ top: 0 });
  const scrollTop = scrollPosition.top;
  const [viewport, setViewport] = useState(0);
  const [heightsVersion, setHeightsVersion] = useState(0);
  const { history, pinned } = splitPinnedSuffix(slots);
  const historyRef = useRef(history);
  historyRef.current = history;
  const prefix = prefixHeights(history.length, (index) => {
    return heightsRef.current.get(history[index]!.key) ?? FEED_ROW_ESTIMATE_PX;
  });
  prefixRef.current = prefix;
  void heightsVersion;

  const range = feedRange(history, scrollTop, viewport, prefix, stickToBottomRef.current, scrollIntentRef.current);

  const onHeight = useCallback((key: string, height: number) => {
    const row = rememberRowHeight({
      heights: heightsRef.current,
      history: historyRef.current,
      prefix: prefixRef.current,
      key,
      height,
      scrollTop: scrollerRef.current?.scrollTop ?? 0,
      stick: stickToBottomRef.current,
      pending: scrollIntentRef.current != null
    });
    const el = scrollerRef.current;
    if (el) el.scrollTop += row.shift;
    if (row.changed) setHeightsVersion((version) => version + 1);
  }, [scrollerRef, stickToBottomRef, scrollIntentRef]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const applied = resolveFeedScroll(el, scrollIntentRef.current, intentTriesRef.current);
    scrollIntentRef.current = applied.intent;
    intentTriesRef.current = applied.tries;
    if (applied.scrollTop != null) {
      applyingScrollRef.current = true;
      el.scrollTop = applied.scrollTop;
      applyingScrollRef.current = false;
      setScrollPosition({ top: el.scrollTop });
    }
    // Layout and browser scroll anchoring can clamp the offset without a new
    // scroll event. Reconcile that position before leaving a tail-only window.
    if (applied.scrollTop == null && el.scrollHeight > el.clientHeight &&
        (Math.abs(el.scrollTop - scrollTop) > 1 ||
          (el.scrollTop <= 1 && range.padTop > 0 && stickToBottomRef.current))) {
      onStickScroll();
      setScrollPosition({ top: el.scrollTop });
    }
    if (el.clientHeight !== viewport) setViewport(el.clientHeight);
    if (shouldAutoLoadOlder(hasOlder, olderLoading, el.scrollHeight, el.clientHeight)) onRequestOlderRef.current('auto');
  }, [layoutKey, hasOlder, heightsVersion, olderLoading, revision, scrollerRef, scrollIntentRef, slots.length, viewport, scrollTop, range.padTop, onStickScroll, stickToBottomRef]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (applyingScrollRef.current) return;
    onStickScroll();
    const el = event.currentTarget;
    const top = el.scrollTop;
    const next = historyWindow({
      count: history.length,
      scrollTop: top,
      viewport: el.clientHeight,
      prefix,
      overscanPx: FEED_OVERSCAN_PX,
      stickToBottom: stickToBottomRef.current,
      fallbackRows: FEED_FALLBACK_ROWS
    });
    // A ref-only follow/anchor change can alter the window even at the same offset.
    // Keep a new state identity in that case so the visible rows are recomputed.
    setScrollPosition((current) => (Math.abs(current.top - top) < 1 && rangesEqual(range, next) ? current : { top }));
    setViewport(el.clientHeight);
    const nearTop = top < FEED_NEAR_TOP_PX;
    const enteredTop = nearTop && !nearTopRef.current;
    nearTopRef.current = nearTop;
    if (enteredTop && hasOlder && !olderLoading && !stickToBottomRef.current) onRequestOlderRef.current('scroll');
  };

  const visible = history.slice(range.start, range.end);
  return (
    <div
      className="chat-feed"
      id="playMessages"
      ref={scrollerRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      onScroll={onScroll}
    >
      <div className="chat-feed__track">
        {header}
        {range.padTop > 0 ? <div className="chat-feed__spacer" style={{ height: range.padTop }} /> : null}
        {visible.map((slot) => (
          <FeedRow key={slot.key} rowKey={slot.key} onHeight={onHeight}>
            {renderSlot(slot)}
          </FeedRow>
        ))}
        {range.padBottom > 0 ? <div className="chat-feed__spacer" style={{ height: range.padBottom }} /> : null}
        {pinned.map((slot) => (
          <FeedRow key={slot.key} rowKey={slot.key} onHeight={onHeight}>
            {renderSlot(slot)}
          </FeedRow>
        ))}
        {footer}
      </div>
    </div>
  );
}


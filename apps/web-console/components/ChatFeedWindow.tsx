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
  historyWindow,
  prefixHeights,
  preservedScrollTop,
  rangeIncluding,
  scrollTopAfterPrepend,
  scrollTopToAnchor,
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
  const [scrollTop, setScrollTop] = useState(0);
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

  const intent = scrollIntentRef.current;
  const focusKey = intent && intent.kind !== 'bottom' ? intent.key : undefined;
  const focusIndex = focusKey ? history.findIndex((slot) => slot.key === focusKey) : -1;
  let range = historyWindow({
    count: history.length,
    scrollTop,
    viewport,
    prefix,
    overscanPx: FEED_OVERSCAN_PX,
    stickToBottom: stickToBottomRef.current,
    fallbackRows: FEED_FALLBACK_ROWS
  });
  if (focusIndex >= 0) range = rangeIncluding(range, focusIndex, history.length, prefix);

  const onHeight = useCallback((key: string, height: number) => {
    const previous = heightsRef.current.get(key) ?? FEED_ROW_ESTIMATE_PX;
    if (Math.abs(previous - height) < 1) {
      heightsRef.current.set(key, height);
      return;
    }
    const index = historyRef.current.findIndex((slot) => slot.key === key);
    const el = scrollerRef.current;
    if (!scrollIntentRef.current && el && index >= 0 && !stickToBottomRef.current) {
      const rowBottom = (prefixRef.current[index] ?? 0) + previous;
      if (rowBottom <= el.scrollTop + 1) el.scrollTop += height - previous;
    }
    heightsRef.current.set(key, height);
    setHeightsVersion((version) => version + 1);
  }, [scrollerRef, stickToBottomRef]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const pending = scrollIntentRef.current;
    if (pending) {
      applyingScrollRef.current = true;
      if (pending.kind === 'bottom') {
        scrollIntentRef.current = null;
        intentTriesRef.current = 0;
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      } else {
        intentTriesRef.current += 1;
        const node =
          pending.key != null
            ? el.querySelector<HTMLElement>(`[data-feed-key="${cssEscape(pending.key)}"]`)
            : null;
        if (node && pending.offset != null) {
          const current = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
          if (Math.abs(current - pending.offset) <= 1 || intentTriesRef.current > 4) {
            scrollIntentRef.current = null;
            intentTriesRef.current = 0;
          }
          el.scrollTop = preservedScrollTop(
            scrollTopToAnchor(el.scrollTop, current, pending.offset),
            el.scrollHeight,
            el.clientHeight
          );
        } else if (pending.kind === 'prepend') {
          scrollIntentRef.current = null;
          intentTriesRef.current = 0;
          el.scrollTop = preservedScrollTop(
            scrollTopAfterPrepend(pending.top, pending.height, el.scrollHeight),
            el.scrollHeight,
            el.clientHeight
          );
        } else {
          scrollIntentRef.current = null;
          intentTriesRef.current = 0;
          el.scrollTop = preservedScrollTop(pending.top, el.scrollHeight, el.clientHeight);
        }
      }
      applyingScrollRef.current = false;
      setScrollTop(el.scrollTop);
    }
    if (el.clientHeight !== viewport) setViewport(el.clientHeight);
    const unread = el.scrollHeight <= el.clientHeight + 1;
    if (hasOlder && !olderLoading && unread) onRequestOlderRef.current('auto');
  }, [hasOlder, heightsVersion, olderLoading, revision, scrollerRef, scrollIntentRef, slots.length, viewport]);

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
    setScrollTop((current) => (Math.abs(current - top) < 1 && rangesEqual(range, next) ? current : top));
    setViewport(el.clientHeight);
    const nearTop = top < FEED_NEAR_TOP_PX;
    const enteredTop = nearTop && !nearTopRef.current;
    nearTopRef.current = nearTop;
    if (enteredTop && !stickToBottomRef.current) onRequestOlderRef.current('scroll');
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

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

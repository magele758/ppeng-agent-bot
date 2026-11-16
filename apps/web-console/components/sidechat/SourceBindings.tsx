'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import type { SidechatPanelRequest } from '../../lib/sidechat-editor';
import { useSourceMarks } from './use-source-marks';
import { selectedAnchor, messageRange } from './source-dom';

const rowSelector = '[data-sidechat-message]';
function selectedRow(range: Range, feed: HTMLElement) {
  const element =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const row = element?.closest<HTMLElement>(rowSelector);
  if (!row || !feed.contains(row) || !element?.closest('.chat-bubble__body')) return null;
  return row;
}
function capture(feed: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  return choiceFromRange(selection.getRangeAt(0), feed);
}
function choiceFromRange(range: Range, feed: HTMLElement) {
  const row = selectedRow(range, feed);
  const messageId = row?.dataset.sidechatMessage;
  if (!row || !messageId) return null;
  const anchor = selectedAnchor(row, range);
  if (!anchor) return null;
  const rect = range.getBoundingClientRect();
  return {
    messageId,
    anchor,
    left: Math.min(Math.max(4, rect.left), window.innerWidth - 104),
    top: Math.max(4, rect.top - 34)
  };
}
export function SourceBindings({
  feedRef,
  threads,
  open,
  sessionId,
  current
}: {
  feedRef: RefObject<HTMLDivElement | null>;
  threads: SidechatThread[];
  open: (r: SidechatPanelRequest) => void;
  sessionId: string;
  current: SidechatPanelRequest | null;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<ReturnType<typeof capture>>(null);
  const [feed, setFeed] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setFeed(feedRef.current);
  });
  const openRef = useRef(open);
  openRef.current = open;
  const markLabel = useCallback((quote: string, count: number) => t('sidechatSource.mark', { quote, count }), [t]);
  useSourceMarks(feed, threads, markLabel, current?.kind === 'thread' ? current.threadId : null);
  useEffect(() => draftHighlight(feed, current), [feed, current]);
  useEffect(() => {
    setChoice(null);
    if (!feed) return;
    const changed = () => setChoice(capture(feed));
    const clear = () => setChoice(null);
    function clicked(e: MouseEvent | KeyboardEvent) {
      if (!activatesMark(e)) return;
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-sidechat-ids]') : null;
      if (!target?.dataset.sidechatIds) return;
      const ids = target.dataset.sidechatIds.split(' ');
      e.preventDefault();
      openRef.current(ids.length === 1 ? { kind: 'thread', threadId: ids[0]! } : { kind: 'list', threadIds: ids });
    }
    document.addEventListener('selectionchange', changed);
    feed.addEventListener('scroll', clear);
    feed.addEventListener('click', clicked);
    feed.addEventListener('keydown', clicked);
    return () => {
      document.removeEventListener('selectionchange', changed);
      feed.removeEventListener('scroll', clear);
      feed.removeEventListener('click', clicked);
      feed.removeEventListener('keydown', clicked);
    };
  }, [feed, sessionId]);
  if (!choice) return null;
  return (
    <button
      type="button"
      data-testid="sidechat-selection"
      className="sidechat-selection"
      style={{ left: choice.left, top: choice.top }}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        open({ kind: 'draft', messageId: choice.messageId, anchor: choice.anchor });
        setChoice(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      {t('sidechatSource.start')}
    </button>
  );
}

function activatesMark(event: MouseEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent) return ['Enter', ' '].includes(event.key);
  return Boolean(window.getSelection()?.isCollapsed);
}

function draftHighlight(feed: HTMLElement | null, current: SidechatPanelRequest | null) {
  if (!feed || current?.kind !== 'draft' || typeof Highlight === 'undefined') return;
  const range = messageRange(feed, current);
  if (!range) return;
  CSS.highlights.set('sidechat-draft', new Highlight(range));
  return () => {
    CSS.highlights.delete('sidechat-draft');
  };
}

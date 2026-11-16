'use client';
import { useEffect, useRef } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { clearSidechatMarks, paintSidechatMarks, setActiveMarks, type MarkLabel } from './source-dom';

const selector = '[data-sidechat-message]';
type MarkerBook = Map<string, SidechatThread[]>;

function groupThreads(threads: SidechatThread[]) {
  const groups: MarkerBook = new Map();
  for (const thread of threads) {
    if (thread.anchor.kind !== 'range') continue;
    const group = groups.get(thread.messageId) ?? [];
    group.push(thread);
    groups.set(thread.messageId, group);
  }
  return groups;
}
function affectedRows(records: MutationRecord[]) {
  const rows = new Set<HTMLElement>();
  for (const record of records) {
    if (!(record.target instanceof Element)) continue;
    const changed = record.target.closest<HTMLElement>(selector);
    if (changed) rows.add(changed);
    for (const added of record.addedNodes) collectRows(rows, added);
  }
  return rows;
}
function collectRows(rows: Set<HTMLElement>, node: Node) {
  if (!(node instanceof HTMLElement)) return;
  if (node.matches(selector)) rows.add(node);
  for (const row of node.querySelectorAll<HTMLElement>(selector)) rows.add(row);
}
function stamp(group: SidechatThread[]) {
  return JSON.stringify(group.map((t) => [t.id, t.ordinal, t.anchor, t.title]));
}
function updateRow(row: HTMLElement, groups: MarkerBook, label: MarkLabel) {
  const family = groups.get(row.dataset.sidechatMessage!);
  if (family) {
    paintSidechatMarks(row, family, label);
    return;
  }
  clearSidechatMarks(row);
}
function changed(row: HTMLElement, old: MarkerBook, next: MarkerBook) {
  const key = row.dataset.sidechatMessage!;
  return stamp(old.get(key) ?? []) !== stamp(next.get(key) ?? []);
}
/** Keep intact DOM ranges in an older answer when another answer streams or the list refreshes. */
export function useSourceMarks(
  feed: HTMLElement | null,
  threads: SidechatThread[],
  label: MarkLabel,
  activeId: string | null
) {
  const active = useRef(activeId);
  active.current = activeId;
  const book = useRef<MarkerBook>(new Map());
  const previous = useRef<MarkerBook>(new Map());
  const update = useRef<(rows: Iterable<HTMLElement>) => void>(() => {});
  useEffect(() => {
    if (!feed) return;
    const observer = new MutationObserver((records) => paint(affectedRows(records)));
    function paint(rows: Iterable<HTMLElement>) {
      observer.disconnect();
      for (const row of rows) {
        updateRow(row, book.current, label);
        setActiveMarks(row, active.current);
      }
      observer.observe(feed!, { childList: true, subtree: true });
    }
    update.current = paint;
    paint(feed.querySelectorAll<HTMLElement>(selector));
    return () => {
      observer.disconnect();
      update.current = () => {};
      clearSidechatMarks(feed);
    };
  }, [feed, label]);
  useEffect(() => {
    const next = groupThreads(threads);
    previous.current = book.current;
    book.current = next;
    if (!feed) return;
    update.current(
      [...feed.querySelectorAll<HTMLElement>(selector)].filter((row) => changed(row, previous.current, next))
    );
  }, [threads, feed]);
  useEffect(() => {
    if (feed) setActiveMarks(feed, activeId);
  }, [feed, activeId]);
}

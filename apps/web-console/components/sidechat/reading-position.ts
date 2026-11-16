import type { RefObject } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { readFeedAnchor } from '../../lib/feed-window';
import type { usePlayChat } from '../usePlayChat';
import { replyMessageId } from '../../lib/reply-quote';
import { markForThread, sourceRange } from './source-dom';

export type Chat = ReturnType<typeof usePlayChat>;
export type ReadingSpot = ReturnType<typeof readFeedAnchor>;
export type Destination = { sessionId: string; thread?: SidechatThread; spot?: ReadingSpot };
type Result = 'done' | 'changed' | 'missing';
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function restoreTop(feed: HTMLElement, saved: ReadingSpot) {
  const row = saved.key ? feed.querySelector<HTMLElement>(`[data-feed-key="${CSS.escape(saved.key)}"]`) : null;
  if (!row) {
    feed.scrollTop = saved.top;
    return;
  }
  feed.scrollTop += row.getBoundingClientRect().top - feed.getBoundingClientRect().top - (saved.offset ?? 0);
}

function jumpToSource(feed: HTMLElement, row: HTMLElement, thread: SidechatThread): Result {
  const mark = markForThread(row, thread.id);
  const range = sourceRange(row, thread.anchor);
  const destination = mark ?? row;
  const rect = (range ?? destination).getBoundingClientRect();
  feed.scrollTop += rect.top - feed.getBoundingClientRect().top - feed.clientHeight / 3;
  if (!mark) destination.tabIndex = -1;
  destination.focus({ preventScroll: true });
  destination.animate?.([{ outline: '2px solid var(--ui-accent)' }, { outline: '2px solid transparent' }], {
    duration: 1200
  });
  return sourceResult(thread, range);
}
function sourceResult(thread: SidechatThread, range: Range | null): Result {
  return thread.anchor.kind === 'range' && !range ? 'changed' : 'done';
}
function rowKey(target: Destination) {
  return target.spot?.key ?? 'm:' + target.thread?.messageId;
}
function hasTarget(chat: Chat, target: Destination) {
  const id = target.thread?.messageId ?? rowKey(target).replace(/^(brief:)?(m:|stats:|apr:)/, '');
  return chat.sessionMessages.some((m) => replyMessageId(m) === id);
}
async function locateLoaded(
  feed: HTMLElement,
  target: Destination,
  signal: AbortSignal
): Promise<Result | undefined> {
  feed.dispatchEvent(new CustomEvent('sidechat-reveal-feed-row', { detail: rowKey(target) }));
  await frame();
  await frame();
  if (signal.aborted) return;
  if (target.spot) {
    restoreTop(feed, target.spot);
    return 'done';
  }
  const thread = target.thread!;
  const row = feed.querySelector<HTMLElement>(`[data-sidechat-message="${CSS.escape(thread.messageId)}"]`);
  if (!row) return 'missing';
  await unfoldSource(row);
  await expandIfNeeded(row, thread);
  if (!signal.aborted) return jumpToSource(feed, row, thread);
}
async function expandIfNeeded(row: Element, thread: SidechatThread) {
  if (thread.anchor.kind !== 'range' || sourceRange(row, thread.anchor)) return;
  const button = row.querySelector<HTMLButtonElement>('.long-message button[aria-expanded="false"]');
  if (button) {
    button.click();
    await frame();
  }
}
function canPage(chat: Chat, previous: number | null | undefined) {
  return !chat.historyError && chat.historyCursor != null && chat.historyCursor !== previous;
}
function fallback(feed: HTMLElement, spot?: ReadingSpot): Result {
  if (!spot) return 'missing';
  restoreTop(feed, spot);
  return 'done';
}
function activeTranscript(chat: Chat, target: Destination, signal: AbortSignal) {
  return !signal.aborted && chat.loadedTranscriptSessionId === target.sessionId;
}
async function findPage(live: RefObject<Chat>, target: Destination, signal: AbortSignal) {
  let previous: number | null | undefined;
  while (activeTranscript(live.current, target, signal)) {
    const chat = live.current;
    if (hasTarget(chat, target)) return true;
    if (chat.historyLoading) {
      await frame();
      continue;
    }
    if (!canPage(chat, previous)) return false;
    previous = chat.historyCursor;
    await chat.loadOlderHistory();
    await frame();
  }
  return false;
}
export async function revealReadingSpot(live: RefObject<Chat>, target: Destination, signal: AbortSignal) {
  const chat = live.current,
    feed = chat.playMessagesRef.current;
  if (!feed) return;
  chat.playStickToBottomRef.current = false;
  chat.feedScrollIntentRef.current = null;
  const found = await findPage(live, target, signal);
  if (signal.aborted) return;
  if (!found) return fallback(feed, target.spot);
  return locateLoaded(feed, target, signal);
}

async function unfoldSource(row: Element) {
  for (
    let ancestor = row.closest('details:not([open])');
    ancestor;
    ancestor = row.closest('details:not([open])')
  ) {
    ancestor.setAttribute('open', '');
    await frame();
  }
}

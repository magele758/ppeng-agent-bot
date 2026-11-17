import type { SidechatAnchor, SidechatThread } from '@ppeng/api-types';

export type ThreadLens = 'all' | 'thinking' | 'mastered' | 'noted';
export type ThreadOrder = 'recent' | 'source';

export function appendCitation(draft: string, heading: string, answer: string): string {
  const block = `> ${heading}\n> ${answer.trim().split('\n').join('\n> ')}\n\n`;
  const base = draft.trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

export function filterThreads(threads: SidechatThread[], lens: ThreadLens): SidechatThread[] {
  if (lens === 'all') return threads;
  if (lens === 'noted') return threads.filter(hasNote);
  return threads.filter(graspIs(lens));
}

export function sortThreads(
  threads: SidechatThread[],
  order: ThreadOrder,
  messageIds: readonly string[]
): SidechatThread[] {
  const copy = [...threads];
  if (order === 'recent') return copy.sort(byRecent);
  return copy.sort((a, b) => bySource(a, b, messageIds));
}

export function threadsForQuote(threads: SidechatThread[], messageId: string, quote: string): SidechatThread[] {
  const clean = quote.trim();
  return threads.filter((thread) => samePassage(thread, messageId, clean));
}

export function nextTitle(value: string | null, current: string): string {
  if (value === null) return '';
  const title = value.trim().slice(0, 120);
  if (!title || title === current) return '';
  return title;
}

function hasNote(thread: SidechatThread): boolean {
  return Boolean(thread.note.trim());
}

function graspIs(lens: ThreadLens) {
  return (thread: SidechatThread) => thread.grasp === lens;
}

function byRecent(a: SidechatThread, b: SidechatThread): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.ordinal - b.ordinal;
}

function bySource(a: SidechatThread, b: SidechatThread, messageIds: readonly string[]): number {
  const delta = sourceRank(a, messageIds) - sourceRank(b, messageIds);
  return delta || (a.anchor.start ?? 0) - (b.anchor.start ?? 0) || a.ordinal - b.ordinal;
}

function sourceRank(thread: SidechatThread, messageIds: readonly string[]): number {
  const index = messageIds.indexOf(thread.messageId);
  return index < 0 ? messageIds.length + thread.ordinal : index;
}

function samePassage(thread: SidechatThread, messageId: string, quote: string): boolean {
  return thread.messageId === messageId && thread.anchor.kind === 'range' && thread.anchor.quote.trim() === quote;
}

export type QuoteChoice = { messageId: string; anchor: SidechatAnchor };

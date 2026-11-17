import type { SidechatAnchor, SidechatThread } from '@ppeng/api-types';
import { createQuoteAnchor, resolveQuoteAnchor } from '../../lib/sidechat-anchor';

const prose = '.chat-bubble__body.chat-bubble__md';
const excluded = 'button, [aria-hidden="true"], .chat-md-code__bar';
const marker = '[data-sidechat-ids]';

function textNodes(root: Element) {
  const nodes: Text[] = [];
  for (const block of root.querySelectorAll(prose)) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest(excluded)) nodes.push(node as Text);
    }
  }
  return nodes;
}

function offsetAt(nodes: Text[], container: Node, offset: number) {
  const point = document.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + offset;
    if (point.comparePoint(node, node.length) > 0) break;
    total += node.length;
  }
  return total;
}

export function selectedAnchor(root: Element, range: Range): SidechatAnchor | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const nodes = textNodes(root);
  const text = nodes.map((node) => node.data).join('');
  const start = offsetAt(nodes, range.startContainer, range.startOffset);
  const end = offsetAt(nodes, range.endContainer, range.endOffset);
  const value = text.slice(start, end);
  if (!value.trim()) return null;
  return createQuoteAnchor(
    text,
    start + value.length - value.trimStart().length,
    end - value.length + value.trimEnd().length
  );
}

export type MarkLabel = (quote: string, count: number) => string;
type MarkRange = { start: number; end: number; thread: SidechatThread };
function markSlice(
  node: Text,
  start: number,
  end: number,
  hits: MarkRange[],
  showNumber: boolean,
  label: MarkLabel
) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const span = document.createElement('span');
  span.dataset.sidechatIds = hits.map((hit) => hit.thread.id).join(' ');
  if (showNumber) span.dataset.sidechatOrdinal = hits.map((hit) => hit.thread.ordinal).join('·');
  span.setAttribute('role', 'button');
  const quotes = [...new Set(hits.map((hit) => hit.thread.anchor.quote.slice(0, 100)))].join(' / ');
  span.setAttribute('aria-label', label(quotes, hits.length));
  decorateMark(span, hits);
  span.tabIndex = showNumber ? 0 : -1;
  range.surroundContents(span);
}
function decorateMark(span: HTMLElement, hits: MarkRange[]) {
  const note = firstNote(hits);
  if (note) span.title = note;
  if (hits.some(masteredHit)) span.dataset.sidechatGrasp = 'mastered';
}
function firstNote(hits: MarkRange[]) {
  for (const hit of hits) {
    const note = (hit.thread.note ?? '').trim();
    if (note) return note;
  }
  return '';
}
function masteredHit(hit: MarkRange) {
  return hit.thread.grasp === 'mastered';
}
function markNode(node: Text, offset: number, ranges: MarkRange[], label: MarkLabel) {
  const end = offset + node.length;
  const hits = ranges.filter((r) => r.end > offset && r.start < end);
  const edges = [...new Set(hits.flatMap((r) => [Math.max(r.start, offset), Math.min(r.end, end)]))].sort(
    (a, b) => b - a
  );
  for (let i = 1; i < edges.length; i++) {
    const left = edges[i]!,
      right = edges[i - 1]!;
    const covering = hits.filter((hit) => hit.start <= left && hit.end >= right);
    if (covering.length)
      markSlice(
        node,
        left - offset,
        right - offset,
        covering,
        covering.some((hit) => hit.end === right),
        label
      );
  }
}
export function clearSidechatMarks(root: Element) {
  for (const span of root.querySelectorAll(marker)) {
    const parent = span.parentNode;
    span.replaceWith(...span.childNodes);
    parent?.normalize();
  }
}
export function paintSidechatMarks(root: Element, threads: SidechatThread[], label: MarkLabel) {
  clearSidechatMarks(root);
  const nodes = textNodes(root);
  const text = nodes.map((node) => node.data).join('');
  const ranges = threads.flatMap((thread) => {
    const pair = resolveQuoteAnchor(text, thread.anchor);
    return pair ? [{ start: pair[0], end: pair[1], thread }] : [];
  });
  let offset = 0;
  for (const node of nodes) {
    const length = node.length;
    markNode(node, offset, ranges, label);
    offset += length;
  }
}
export function markForThread(row: Element, id: string) {
  return row.querySelector<HTMLElement>(`[data-sidechat-ids~="${CSS.escape(id)}"]`);
}

function containsStart(offset: number, end: number, start: number) {
  return offset <= start && start < end;
}
function containsEnd(offset: number, end: number, finish: number) {
  return offset < finish && finish <= end;
}
export function sourceRange(row: Element, anchor: SidechatAnchor) {
  const nodes = textNodes(row);
  const positions = resolveQuoteAnchor(nodes.map((node) => node.data).join(''), anchor);
  if (!positions) return null;
  const range = document.createRange();
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.length;
    if (containsStart(offset, end, positions[0])) range.setStart(node, positions[0] - offset);
    if (containsEnd(offset, end, positions[1])) {
      range.setEnd(node, positions[1] - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

export function setActiveMarks(root: Element, active: string | null) {
  for (const mark of root.querySelectorAll<HTMLElement>(marker)) {
    const selected = Boolean(active && mark.dataset.sidechatIds?.split(' ').includes(active));
    mark.toggleAttribute('data-sidechat-active', selected);
    mark.setAttribute('aria-pressed', String(selected));
  }
}

export function messageRange(feed: Element, source: { messageId: string; anchor: SidechatAnchor }) {
  const row = feed.querySelector('[data-sidechat-message="' + CSS.escape(source.messageId) + '"]');
  return row ? sourceRange(row, source.anchor) : null;
}

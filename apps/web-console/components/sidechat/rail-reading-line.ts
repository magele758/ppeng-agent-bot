/** A text range stays on the same character when opening the rail changes wrapping. */
export type ReadingLine = { range: Range; y: number };

function firstRect(range: Range) {
  return range.getClientRects()[0];
}
function visibleLine(feed: HTMLElement, range: Range | undefined | null) {
  if (!range) return null;
  const line = firstRect(range);
  const viewport = feed.getBoundingClientRect();
  if (!line || line.bottom <= viewport.top || line.top >= viewport.bottom) return null;
  return { range: range.cloneRange(), y: line.top - viewport.top };
}
function character(node: Text, index: number) {
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + 1);
  return range;
}
/** First visible character on/below the reference line; binary search avoids measuring a whole answer glyph by glyph. */
function nearTop(node: Text, y: number) {
  let left = 0,
    right = node.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (character(node, mid).getBoundingClientRect().bottom <= y) left = mid + 1;
    else right = mid;
  }
  return left < node.length ? character(node, left) : null;
}
function lineInBlock(block: Element, y: number) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const r = document.createRange();
    r.selectNodeContents(n);
    if (r.getBoundingClientRect().bottom <= y) continue;
    const candidate = nearTop(n as Text, y);
    if (candidate) return candidate;
  }
  return null;
}
function firstTextInView(feed: HTMLElement) {
  const viewport = feed.getBoundingClientRect();
  const y = viewport.top + Math.min(20, viewport.height / 4);
  for (const block of feed.querySelectorAll('.chat-bubble__body')) {
    const box = block.getBoundingClientRect();
    if (box.bottom <= y || box.top >= viewport.bottom) continue;
    const line = lineInBlock(block, y);
    if (line) return line;
  }
  return null;
}
export function captureLine(feed: HTMLElement, preferred?: Range | null) {
  return visibleLine(feed, preferred) ?? visibleLine(feed, firstTextInView(feed));
}
export function restoreLine(feed: HTMLElement, anchor: ReadingLine | null) {
  if (!anchor || !feed.contains(anchor.range.startContainer)) return false;
  const rect = firstRect(anchor.range);
  if (!rect) return false;
  feed.scrollTop += rect.top - feed.getBoundingClientRect().top - anchor.y;
  return true;
}

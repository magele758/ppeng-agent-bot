/**
 * Escape-first markdown → safe HTML for public share pages.
 *
 * All user text is HTML-escaped before any tags are introduced, so raw HTML in
 * the source cannot execute. Only a small markdown subset is recognized.
 */

export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMarkdown(escaped: string): string {
  let out = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?![*])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = safeHref(href);
    if (!safe) return label;
    return `<a href="${safe}" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

/** Allow only http(s)/mailto hrefs; reject javascript: and other schemes. */
export function safeHref(raw: string): string | null {
  const href = String(raw ?? '').trim();
  if (!href) return null;
  const decoded = href
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  if (!/^(https?:|mailto:)/i.test(decoded)) return null;
  if (/[\s<>"]/.test(decoded)) return null;
  return escapeHtml(decoded);
}

/**
 * Convert markdown to a safe HTML fragment (no document shell).
 * Unsupported constructs render as escaped plain text.
 */
type ListTag = 'ul' | 'ol';

interface MdBlocks {
  blocks: string[];
  para: string[];
  listItems: string[];
  listTag: ListTag | null;
}

function flushPara(state: MdBlocks): void {
  if (!state.para.length) return;
  state.blocks.push(`<p>${inlineMarkdown(escapeHtml(state.para.join('\n')))}</p>`);
  state.para = [];
}

function flushList(state: MdBlocks): void {
  if (!state.listTag || !state.listItems.length) {
    state.listItems = [];
    state.listTag = null;
    return;
  }
  state.blocks.push(`<${state.listTag}>${state.listItems.join('')}</${state.listTag}>`);
  state.listItems = [];
  state.listTag = null;
}

function closeFence(state: MdBlocks, fenceLang: string, fenceLines: string[]): void {
  const code = escapeHtml(fenceLines.join('\n'));
  const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
  state.blocks.push(`<pre><code${langClass}>${code}</code></pre>`);
}

function pushHeading(state: MdBlocks, level: number, body: string): void {
  flushPara(state);
  flushList(state);
  state.blocks.push(`<h${level}>${inlineMarkdown(escapeHtml(body))}</h${level}>`);
}

function pushListItem(state: MdBlocks, tag: ListTag, body: string): void {
  flushPara(state);
  if (state.listTag && state.listTag !== tag) flushList(state);
  state.listTag = tag;
  state.listItems.push(`<li>${inlineMarkdown(escapeHtml(body))}</li>`);
}

function pushParagraphLine(state: MdBlocks, line: string): void {
  flushList(state);
  state.para.push(line);
}

function consumeNonFenceLine(state: MdBlocks, line: string): void {
  if (/^\s*$/.test(line)) {
    flushPara(state);
    flushList(state);
    return;
  }
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    pushHeading(state, heading[1]!.length, heading[2]!);
    return;
  }
  const ul = line.match(/^\s*[-*+]\s+(.+)$/);
  if (ul) {
    pushListItem(state, 'ul', ul[1]!);
    return;
  }
  const ol = line.match(/^\s*\d+\.\s+(.+)$/);
  if (ol) {
    pushListItem(state, 'ol', ol[1]!);
    return;
  }
  const bq = line.match(/^\s*>\s?(.*)$/);
  if (bq) {
    flushPara(state);
    flushList(state);
    state.blocks.push(`<blockquote><p>${inlineMarkdown(escapeHtml(bq[1] ?? ''))}</p></blockquote>`);
    return;
  }
  const hr = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  if (hr) {
    flushPara(state);
    flushList(state);
    state.blocks.push('<hr />');
    return;
  }
  pushParagraphLine(state, line);
}

export function markdownToSafeHtml(markdown: string): string {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';

  const lines = src.split('\n');
  const state: MdBlocks = { blocks: [], para: [], listItems: [], listTag: null };
  let i = 0;
  let inFence = false;
  let fenceLang = '';
  let fenceLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceOpen = line.match(/^```([\w-]*)\s*$/);
    if (fenceOpen && !inFence) {
      flushPara(state);
      flushList(state);
      inFence = true;
      fenceLang = fenceOpen[1] ?? '';
      fenceLines = [];
      i += 1;
      continue;
    }
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        closeFence(state, fenceLang, fenceLines);
        inFence = false;
        fenceLang = '';
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      i += 1;
      continue;
    }
    consumeNonFenceLine(state, line);
    i += 1;
  }
  if (inFence) {
    // Unclosed fence: emit remaining lines as a code block.
    closeFence(state, fenceLang, fenceLines);
  }
  flushPara(state);
  flushList(state);
  return state.blocks.join('\n');
}

export function renderPageShareDocument(input: { title: string; markdown: string }): string {
  const title = escapeHtml(String(input.title ?? '').trim() || 'Untitled');
  const body = markdownToSafeHtml(input.markdown);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.55; max-width: 44rem; margin: 2rem auto; padding: 0 1.25rem; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.25; }
  pre { overflow-x: auto; padding: 0.75rem 1rem; background: #f4f4f5; border-radius: 0.375rem; }
  @media (prefers-color-scheme: dark) { pre { background: #1f1f23; } }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  a { color: inherit; }
</style>
</head>
<body>
<article>
<header><h1>${title}</h1></header>
${body}
</article>
</body>
</html>
`;
}

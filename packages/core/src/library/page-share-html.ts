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
export function markdownToSafeHtml(markdown: string): string {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';

  const lines = src.split('\n');
  const blocks: string[] = [];
  let i = 0;
  let para: string[] = [];
  let listItems: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  let inFence = false;
  let fenceLang = '';
  let fenceLines: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${inlineMarkdown(escapeHtml(para.join('\n')))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!listTag || !listItems.length) {
      listItems = [];
      listTag = null;
      return;
    }
    blocks.push(`<${listTag}>${listItems.join('')}</${listTag}>`);
    listItems = [];
    listTag = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fenceOpen = line.match(/^```([\w-]*)\s*$/);
    if (fenceOpen && !inFence) {
      flushPara();
      flushList();
      inFence = true;
      fenceLang = fenceOpen[1] ?? '';
      fenceLines = [];
      i += 1;
      continue;
    }
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        const code = escapeHtml(fenceLines.join('\n'));
        const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
        blocks.push(`<pre><code${langClass}>${code}</code></pre>`);
        inFence = false;
        fenceLang = '';
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      i += 1;
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]!))}</h${level}>`);
      i += 1;
      continue;
    }

    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listTag && listTag !== 'ul') flushList();
      listTag = 'ul';
      listItems.push(`<li>${inlineMarkdown(escapeHtml(ul[1]!))}</li>`);
      i += 1;
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listTag && listTag !== 'ol') flushList();
      listTag = 'ol';
      listItems.push(`<li>${inlineMarkdown(escapeHtml(ol[1]!))}</li>`);
      i += 1;
      continue;
    }

    flushList();
    para.push(line);
    i += 1;
  }

  if (inFence) {
    flushPara();
    flushList();
    blocks.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  } else {
    flushPara();
    flushList();
  }

  return blocks.join('\n');
}

/** Full minimal HTML document for a shared library page (read-only). */
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

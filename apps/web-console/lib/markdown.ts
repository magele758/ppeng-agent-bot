import DOMPurify from 'dompurify';
import { Marked, Renderer, type Tokens } from 'marked';

const LANG_OK = /^[A-Za-z0-9_+#.-]+$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

let anchorHookInstalled = false;

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attrText(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function fenceLang(lang: string | undefined): string {
  const name = lang ?? '';
  if (LANG_OK.test(name)) return name;
  return '';
}

function codeBody(text: string, escaped: boolean | undefined): string {
  if (escaped) return text;
  return escapeHtml(text);
}

function langClass(lang: string): string {
  if (!lang) return '';
  return ` class="language-${escapeHtml(lang)}"`;
}

function codeFrame(text: string, lang: string): string {
  const label = escapeHtml(lang);
  return `<div class="chat-md-code"><div class="chat-md-code__bar"><span class="chat-md-code__lang">${label}</span><button type="button" class="chat-md-code__copy" data-md-copy></button></div><pre><code${langClass(lang)}>${text}</code></pre></div>`;
}

function renderCode(this: Renderer, token: Tokens.Code): string {
  const lang = fenceLang(token.lang);
  return codeFrame(codeBody(token.text, token.escaped), lang);
}

function schemeOf(value: string): string {
  return SCHEME.exec(value)?.[1]?.toLowerCase() ?? '';
}

function isBlockedHref(value: string): boolean {
  if (!value) return true;
  return value.startsWith('//');
}

function isAllowedScheme(scheme: string): boolean {
  if (scheme === 'http' || scheme === 'https') return true;
  return scheme === 'mailto';
}

function isWebHref(value: string): boolean {
  if (isBlockedHref(value)) return false;
  const scheme = schemeOf(value);
  if (!scheme) return true;
  return isAllowedScheme(scheme);
}

function linkTitle(title: string | null | undefined): string {
  if (!title) return '';
  return ` title="${attrText(title)}"`;
}

function renderLink(this: Renderer, token: Tokens.Link): string {
  const text = this.parser.parseInline(token.tokens);
  const href = token.href.trim();
  if (!isWebHref(href)) return text;
  return `<a href="${attrText(href)}"${linkTitle(token.title)} target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function renderRawHtml(token: Tokens.HTML | Tokens.Tag): string {
  return escapeHtml(token.text);
}

function renderImage(token: Tokens.Image): string {
  const alt = escapeHtml(token.text);
  const href = token.href.trim();
  if (!isWebHref(href)) return alt;
  return `<img src="${attrText(href)}" alt="${alt}"${linkTitle(token.title)}>`;
}

function renderTable(this: Renderer, token: Tokens.Table): string {
  const inner = Renderer.prototype.table.call(this, token);
  return `<div class="chat-md-table">${inner}</div>`;
}

// A blank line separates paragraphs. A single newline stays inside the paragraph.
const chatMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code: renderCode,
    link: renderLink,
    image: renderImage,
    html: renderRawHtml,
    table: renderTable,
  },
});

/**
 * When the model returns a full HTML5 document (common if the user asks for
 * "structured HTML"), embedding `<html>…</html>` inside a chat bubble is invalid
 * and breaks layout. If the string looks like a complete document, return the
 * inner body (or the document shell with `<head>` removed); otherwise `null`.
 */
export function extractHtmlDocumentFragment(src: string): string | null {
  const trimmed = String(src ?? '').trim();
  if (!trimmed) return null;
  const startsAsDoc =
    /^<!DOCTYPE\s+html\b/i.test(trimmed) || /^<html\b/i.test(trimmed);
  if (!startsAsDoc) return null;
  if (!/<\/html\s*>$/i.test(trimmed)) return null;

  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyInner = bodyMatch?.[1]?.trim();
  if (bodyInner) return bodyInner;

  let inner = trimmed.replace(/^<!DOCTYPE[^>]*>\s*/i, '');
  inner = inner.replace(/^<html[^>]*>/i, '').replace(/<\/html\s*>$/i, '');
  inner = inner.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '').trim();
  return inner.length ? inner : null;
}

function stampBlankAnchor(node: { tagName: string; setAttribute(name: string, value: string): void }): void {
  if (node.tagName !== 'A') return;
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
}

function ensureAnchorHook(): void {
  if (anchorHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', stampBlankAnchor);
  anchorHookInstalled = true;
}

function purify(html: string): string {
  ensureAnchorHook();
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function presentDocument(docFrag: string): string {
  if (typeof DOMPurify.sanitize !== 'function') return escapeHtml(docFrag);
  return purify(docFrag);
}

function renderPrepared(text: string): string {
  const docFrag = extractHtmlDocumentFragment(text);
  if (docFrag !== null) return presentDocument(docFrag);
  // Markdown is escaped at parse time. Skipping DOMPurify keeps server and
  // browser HTML identical; the sanitizer rewrites attribute order.
  return chatMarkdownHtml(text);
}

export function chatMarkdownHtml(src: string): string {
  return chatMarked.parse(src, { async: false });
}

export function renderMarkdown(src: string): string {
  const text = String(src ?? '');
  if (!text.trim()) return '';
  try {
    return renderPrepared(text);
  } catch {
    return escapeHtml(text);
  }
}

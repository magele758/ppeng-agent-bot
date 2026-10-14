import {
  fetchPinnedPublic,
  PrivateNetworkDenied,
  webFetchAllowsPrivate,
  type PublicFetchDeps
} from '../net/public-fetch.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { WEB_SEARCH_NOT_CONFIGURED } from './web-settings.js';

export { webFetchAllowsPrivate };

export interface WebFetchOptions extends PublicFetchDeps {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX = 2_000_000;

/** arXiv id in URLs: YYMM.nnnnn plus optional version suffix. */
const ARXIV_ID_IN_PATH = /(\d{4}\.\d{4,5})(?:v\d+)?/;

/**
 * When the URL is an arXiv abstract/PDF/HTML page, returns the paper id (e.g. `2501.06322`, `2501.06322v2`).
 * Used to prefer the official Atom API over scraping HTML (more reliable for research links).
 */
export function extractArxivPaperIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const h = parsed.hostname.toLowerCase();
  if (h !== 'arxiv.org' && h !== 'www.arxiv.org') {
    return null;
  }
  const m = parsed.pathname.match(ARXIV_ID_IN_PATH);
  return m ? m[0] : null;
}

function parseArxivAtomEntry(xml: string): { title: string; summary: string; authors: string[] } | null {
  const entry = xml.match(/<entry[\s\S]*?<\/entry>/)?.[0];
  if (!entry) {
    return null;
  }
  const title =
    entry
      .match(/<title>([\s\S]*?)<\/title>/)?.[1]
      ?.trim()
      .replace(/\s+/g, ' ') ?? '';
  const summary =
    entry
      .match(/<summary>([\s\S]*?)<\/summary>/)?.[1]
      ?.trim()
      .replace(/\s+/g, ' ') ?? '';
  const authors: string[] = [];
  const authorRegex = /<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/g;
  let authorMatch: RegExpExecArray | null;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    authors.push(authorMatch[1]!.trim());
  }
  if (!title && !summary) {
    return null;
  }
  return { title, summary, authors };
}

/**
 * Fetch paper title + abstract from arXiv Atom export API (fixed host; does not follow user-controlled redirects).
 */
async function tryFetchArxivApiText(
  arxivId: string,
  init: PublicFetchDeps & { signal: AbortSignal }
): Promise<string | null> {
  const bases = ['https://export.arxiv.org/api/query', 'http://export.arxiv.org/api/query'];
  for (const base of bases) {
    const apiUrl = `${base}?id_list=${encodeURIComponent(arxivId)}`;
    try {
      const res = await fetchPinnedPublic(apiUrl, {
        ...init,
        method: 'GET',
        headers: {
          'user-agent': 'raw-agent-web_fetch/1.0 (arxiv export api)',
          accept: 'application/atom+xml,text/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const xml = await res.text();
      const parsed = parseArxivAtomEntry(xml);
      if (!parsed) {
        continue;
      }
      const authorLine = parsed.authors.length ? `\nAuthors: ${parsed.authors.join(', ')}\n` : '';
      const body =
        `${parsed.title ? `Title: ${parsed.title}\n` : ''}` +
        `${authorLine}` +
        `${parsed.summary ? `\nAbstract:\n${parsed.summary}\n` : ''}`;
      return body.trim() || null;
    } catch {
      continue;
    }
  }
  return null;
}

const DEFAULT_FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; raw-agent-web_fetch/1.0)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7'
} as const;

/**
 * Fetch http(s) URL as text with size cap.
 * Private, CGNAT, and mapped addresses are refused unless allowPrivateHosts is set.
 * DNS answers and every redirect hop use the same check, and the socket stays on the approved address.
 */
export async function fetchUrlText(options: WebFetchOptions): Promise<{ ok: boolean; content: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return { ok: false, content: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, content: 'Only http(s) URLs are allowed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const transport = {
    allowPrivateHosts: options.allowPrivateHosts === true,
    resolveHost: options.resolveHost,
    request: options.request,
    maxRedirects: options.maxRedirects,
    dnsTimeoutMs: options.dnsTimeoutMs,
    signal: controller.signal
  };
  try {
    const arxivId = extractArxivPaperIdFromUrl(options.url);
    if (arxivId) {
      const apiText = await tryFetchArxivApiText(arxivId, transport);
      if (apiText) {
        return {
          ok: true,
          content: `Content-Type: application/x-arxiv-metadata+plain\nSource: arXiv Atom API (id_list=${arxivId})\n\n${apiText}`
        };
      }
    }

    const res = await fetchPinnedPublic(options.url, {
      ...transport,
      method: 'GET',
      headers: { ...DEFAULT_FETCH_HEADERS }
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        content: fenceExternalContent({
          source: 'web_fetch',
          label: options.url,
          body: `HTTP ${res.status} ${res.statusText}`
        })
      };
    }
    const buf = await readLimitedBody(res.body, maxBytes);
    const text = decodeBody(buf, ct);
    return {
      ok: true,
      content: `Content-Type: ${ct}\n\n${text}`
    };
  } catch (e) {
    if (e instanceof PrivateNetworkDenied) {
      return { ok: false, content: e.message };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      content: fenceExternalContent({
        source: 'web_fetch',
        label: options.url,
        body: `fetch failed: ${msg}`
      })
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
    if (offset >= maxBytes) {
      break;
    }
  }
  return out.subarray(0, Math.min(offset, maxBytes));
}

/** Extract MIME charset from Content-Type (e.g. `text/html; charset=iso-8859-1`). */
function charsetFromContentTypeHeader(contentType: string): string | null {
  const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType);
  return m?.[1] ? normalizeEncodingLabel(m[1]) : null;
}

/**
 * Normalize common legacy labels to WHATWG encoding names TextDecoder accepts.
 */
function normalizeEncodingLabel(raw: string): string | null {
  const s = raw.trim();
  if (!s) {
    return null;
  }
  const low = s.toLowerCase();
  if (low === 'gb2312' || low === 'gb_2312-80' || low === 'chinese') {
    return 'gbk';
  }
  if (low === 'utf8') {
    return 'utf-8';
  }
  return s;
}

function textDecoderForLabel(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return null;
  }
}

function decodeWithLabel(buf: Uint8Array, label: string): string {
  const dec = textDecoderForLabel(label);
  if (dec) {
    return dec.decode(buf);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

const META_CHARSET_RE = /<meta\s+charset\s*=\s*["']?([^"'>\s]+)/i;
const META_HTTP_EQUIV_CT_RE =
  /<meta\b[^>]*http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["']([^"']*)["']/i;
/** Same as above when `content=` precedes `http-equiv` (common in minified HTML). */
const META_HTTP_EQUIV_CT_RE_ATTR_REV =
  /<meta\b[^>]*content\s*=\s*["']([^"']*charset\s*=\s*[^"']*)["'][^>]*http-equiv\s*=\s*["']?content-type["']?/i;

/**
 * Sniff charset from HTML &lt;meta&gt; in the first bytes (header omitted charset).
 * Uses Latin-1 over the prefix so ASCII tags remain regex-stable regardless of body encoding.
 */
export function sniffHtmlMetaCharset(buf: Uint8Array, maxScan = 65536): string | null {
  const n = Math.min(buf.length, maxScan);
  if (n === 0) {
    return null;
  }
  const prefix = new TextDecoder('iso-8859-1', { fatal: false }).decode(buf.subarray(0, n));
  const direct = META_CHARSET_RE.exec(prefix);
  if (direct?.[1]) {
    return normalizeEncodingLabel(direct[1]);
  }
  let equiv = META_HTTP_EQUIV_CT_RE.exec(prefix);
  if (!equiv) {
    equiv = META_HTTP_EQUIV_CT_RE_ATTR_REV.exec(prefix);
  }
  if (equiv?.[1]) {
    const inner = /charset\s*=\s*([^;'"\s]+)/i.exec(equiv[1]);
    if (inner?.[1]) {
      return normalizeEncodingLabel(inner[1]);
    }
  }
  return null;
}

function decodeBody(buf: Uint8Array, contentType: string): string {
  const low = contentType.toLowerCase();
  const headerCharset = charsetFromContentTypeHeader(contentType);
  const isHtml = low.includes('text/html') || low.includes('application/xhtml+xml');

  if (headerCharset) {
    return decodeWithLabel(buf, headerCharset);
  }

  if (isHtml) {
    const metaCharset = sniffHtmlMetaCharset(buf);
    if (metaCharset) {
      return decodeWithLabel(buf, metaCharset);
    }
  }

  if (low.includes('charset=utf-8') || (!low.includes('charset') && isMostlyText(buf))) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  if (low.startsWith('text/') || low.includes('json') || low.includes('xml')) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  return `[binary or unknown encoding, ${buf.byteLength} bytes]\n` + new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 4096));
}

/**
 * Decode a fetched HTTP body using Content-Type and (for HTML) optional &lt;meta charset&gt; sniffing.
 * Exported for unit tests and advanced callers.
 */
export function decodeFetchedBodyAsText(buf: Uint8Array, contentType: string): string {
  return decodeBody(buf, contentType);
}

function isMostlyText(buf: Uint8Array): boolean {
  let bad = 0;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b < 9 || (b > 13 && b < 32)) {
      bad++;
    }
  }
  return bad / n < 0.03;
}

export interface WebSearchOptions {
  query: string;
  templateUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * GET a search-URL template (Lab KV or RAW_AGENT_WEB_SEARCH_URL). Unconfigured → guidance, not a throw.
 */
export async function webSearchFromEnv(
  env: NodeJS.ProcessEnv,
  options: WebSearchOptions
): Promise<{ ok: boolean; content: string }> {
  const template = options.templateUrl ?? env.RAW_AGENT_WEB_SEARCH_URL?.trim();
  if (!template) {
    return {
      ok: false,
      content: WEB_SEARCH_NOT_CONFIGURED
    };
  }
  const url = template.replace(/\{query\}/g, encodeURIComponent(options.query));
  return fetchUrlText({
    url,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    allowPrivateHosts: webFetchAllowsPrivate(env)
  });
}

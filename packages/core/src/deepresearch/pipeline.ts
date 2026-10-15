import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nowIso } from '../id.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { fetchUrlText, webFetchAllowsPrivate, webSearchFromEnv } from '../tools/web-fetch.js';
import { ResearchStore } from './store.js';
import type { ClaimConfidence, ResearchSource, ResearchTask, SourceKind, TrustLevel } from './types.js';

export interface ResearchPipelineDeps {
  store: ResearchStore;
  /** Optional state dir for writing markdown reports */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected search (tests); default uses webSearchFromEnv */
  search?: (query: string) => Promise<{ ok: boolean; content: string }>;
  /** Injected fetch (tests); default uses fetchUrlText */
  fetchText?: (url: string) => Promise<{ ok: boolean; content: string }>;
}

interface ParsedHit {
  title: string;
  url: string;
  snippet: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const MAX_SOURCES = 5;
const MAX_FETCH = 3;

function trustForUrl(url: string): { kind: SourceKind; trust: TrustLevel } {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('arxiv.org')) return { kind: 'arxiv', trust: 'primary' };
    if (h.includes('github.com')) return { kind: 'github', trust: 'primary' };
    if (h.endsWith('.gov') || h.endsWith('.edu')) return { kind: 'web', trust: 'primary' };
    return { kind: 'web', trust: 'secondary' };
  } catch {
    return { kind: 'web', trust: 'unknown' };
  }
}

function parseSearchHits(raw: string, query: string): ParsedHit[] {
  const hits: ParsedHit[] = [];
  const seen = new Set<string>();

  // Prefer line-oriented "title — url" / markdown links
  for (const line of raw.split('\n')) {
    const md = line.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
    if (md) {
      const url = md[2]!.replace(/[.,;]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      hits.push({ title: md[1]!.slice(0, 120), url, snippet: line.slice(0, 400) });
      continue;
    }
    const urls = line.match(URL_RE);
    if (urls?.[0]) {
      const url = urls[0].replace(/[.,;]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      hits.push({
        title: line.replace(url, '').trim().slice(0, 120) || `Result for ${query.slice(0, 40)}`,
        url,
        snippet: line.slice(0, 400)
      });
    }
  }

  if (hits.length === 0) {
    for (const m of raw.matchAll(URL_RE)) {
      const url = m[0]!.replace(/[.,;]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      hits.push({ title: url, url, snippet: raw.slice(0, 300) });
      if (hits.length >= MAX_SOURCES) break;
    }
  }

  return hits.slice(0, MAX_SOURCES);
}

function clipQuote(text: string, max = 1200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function researchSourceLabel(url: string | undefined, title: string): string {
  return url || title;
}

function fenceResearchQuote(quote: string, label: string): string {
  return fenceExternalContent({ source: 'web_fetch', label, body: clipQuote(quote, 500) });
}

function synthesizeClaims(
  query: string,
  evidences: Array<{ id: string; quote: string; sourceTitle: string }>
): Array<{ text: string; confidence: ClaimConfidence; evidenceIds: string[]; caveats?: string[] }> {
  if (evidences.length === 0) {
    return [
      {
        text: `No live sources retrieved for "${query}". Configure RAW_AGENT_WEB_SEARCH_URL or provide URLs in scope.`,
        confidence: 'low',
        evidenceIds: [],
        caveats: ['empty_search']
      }
    ];
  }
  const ids = evidences.map((e) => e.id);
  const lead = evidences[0]!;
  return [
    {
      text: `Based on ${evidences.length} source(s), key context for "${query}": ${lead.quote}`,
      confidence: evidences.length >= 3 ? 'high' : evidences.length === 2 ? 'medium' : 'low',
      evidenceIds: ids.slice(0, 3)
    },
    {
      text: `Sources consulted: ${evidences.map((e) => e.sourceTitle).join('; ')}`,
      confidence: 'medium',
      evidenceIds: ids
    }
  ];
}

async function writeReport(
  stateDir: string | undefined,
  task: ResearchTask,
  sources: ResearchSource[],
  claims: Array<{ text: string; confidence: string }>,
  evidences: Array<{ quote: string }>
): Promise<string | undefined> {
  if (!stateDir) return undefined;
  const dir = join(stateDir, 'research');
  await mkdir(dir, { recursive: true });
  const rel = `research/${task.id}.md`;
  const abs = join(stateDir, rel);
  const md = [
    `# Research: ${task.query}`,
    '',
    `Status: completed`,
    `Updated: ${nowIso()}`,
    '',
    '## Sources',
    ...sources.map((s) => `- [${s.title}](${s.url ?? ''}) (${s.kind}, ${s.trustLevel})`),
    '',
    '## Evidence',
    ...evidences.map((e, i) => `${i + 1}. ${e.quote}`),
    '',
    '## Claims',
    ...claims.map((c) => `- (${c.confidence}) ${c.text}`),
    ''
  ].join('\n');
  await writeFile(abs, md, 'utf8');
  return rel;
}

/**
 * Real research pipeline: web search → fetch top URLs → evidence → claims → report.
 * Falls back gracefully when search is unconfigured (records failure claim, not fake success).
 */
export class ResearchPipeline {
  constructor(private readonly deps: ResearchPipelineDeps) {}

  async runTask(taskId: string): Promise<ResearchTask | undefined> {
    const task = this.deps.store.getTask(taskId);
    if (!task) return undefined;
    const env = this.deps.env ?? process.env;

    this.deps.store.updateTaskStatus(taskId, 'searching');

    const searchFn =
      this.deps.search ??
      ((q: string) => webSearchFromEnv(env, { query: q, maxBytes: 200_000, timeoutMs: 25_000 }));

    let searchContent = '';
    let searchOk = false;
    try {
      const r = await searchFn(task.query);
      searchOk = r.ok;
      searchContent = r.content;
    } catch (e) {
      searchContent = e instanceof Error ? e.message : String(e);
    }

    // Allow scope to carry explicit URLs (comma/newline separated)
    const scopeUrls = (task.scope ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s));

    let hits = parseSearchHits(searchContent, task.query);
    for (const u of scopeUrls) {
      if (!hits.some((h) => h.url === u)) {
        hits.unshift({ title: u, url: u, snippet: `Scoped URL for ${task.query}` });
      }
    }
    hits = hits.slice(0, MAX_SOURCES);

    if (!searchOk && hits.length === 0) {
      this.deps.store.updateTaskStatus(taskId, 'failed');
      this.deps.store.addClaim({
        taskId,
        text: `Research failed: web search unavailable. ${clipQuote(searchContent, 400)}`,
        confidence: 'low',
        evidenceIds: [],
        caveats: ['search_unavailable']
      });
      return this.deps.store.getTask(taskId);
    }

    const sources: ResearchSource[] = [];
    for (const hit of hits) {
      const { kind, trust } = trustForUrl(hit.url);
      sources.push(
        this.deps.store.addSource({
          taskId,
          kind,
          url: hit.url,
          title: hit.title || hit.url,
          fetchedAt: nowIso(),
          trustLevel: trust
        })
      );
    }

    this.deps.store.updateTaskStatus(taskId, 'extracting');
    const fetchFn =
      this.deps.fetchText ??
      ((url: string) =>
        fetchUrlText({
          url,
          maxBytes: 120_000,
          timeoutMs: 20_000,
          allowPrivateHosts: webFetchAllowsPrivate(env)
        }));

    const evidenceRows: Array<{ id: string; quote: string; sourceTitle: string }> = [];
    for (const src of sources.slice(0, MAX_FETCH)) {
      const hit = hits.find((h) => h.url === src.url);
      let quote = hit?.snippet ?? '';
      if (src.url) {
        try {
          const page = await fetchFn(src.url);
          if (page.ok && page.content.trim()) {
            quote = clipQuote(page.content, 1500);
          }
        } catch {
          /* keep snippet */
        }
      }
      if (!quote.trim()) quote = `Title-only hit: ${src.title}`;
      const fenced = fenceResearchQuote(quote, researchSourceLabel(src.url, src.title));
      const ev = this.deps.store.addEvidence({
        taskId,
        sourceId: src.id,
        quote: fenced,
        location: src.url,
        relevance: src.trustLevel === 'primary' ? 0.9 : 0.7
      });
      evidenceRows.push({ id: ev.id, quote: fenced, sourceTitle: src.title });
    }

    this.deps.store.updateTaskStatus(taskId, 'synthesizing');
    const claimDefs = synthesizeClaims(task.query, evidenceRows);
    const claims: Array<{ text: string; confidence: string }> = [];
    for (const c of claimDefs) {
      this.deps.store.addClaim({
        taskId,
        text: c.text,
        confidence: c.confidence,
        evidenceIds: c.evidenceIds,
        caveats: c.caveats
      });
      claims.push({ text: c.text, confidence: c.confidence });
    }

    const reportPath = await writeReport(
      this.deps.stateDir,
      task,
      sources,
      claims,
      evidenceRows
    );

    return this.deps.store.updateTaskStatus(taskId, 'completed', {
      reportPath: reportPath ?? `research/${taskId}.md`
    });
  }
}

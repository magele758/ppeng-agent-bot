/**
 * Semantic fact merge: prevent duplicate identity facts when wording changes.
 */

import { isLowValueSemanticContent, sanitizeSemanticFactContent } from './memory-gate.js';

export const SEMANTIC_MERGE_SCORE_MIN = 0.78;

const IDENTITY_HINT_RE = /姓名|名字|称呼|叫我|叫你|职业|就职|公司|偏好|助手|工程师|用户是|我是/;

export interface SemanticMergeHit {
  id: string;
  content: string;
  score: number;
  category?: string;
}

export type SemanticCategory = 'fact' | 'preference' | 'entity' | 'concept';

export function mergeSemanticFactContent(existing: string, incoming: string): string {
  const a = sanitizeSemanticFactContent(existing);
  const b = sanitizeSemanticFactContent(incoming);
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  if (/^(?:更正|纠正|修正|correction)\s*[:：]/i.test(b)) return b;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;

  const parts = [...splitFactParts(a), ...splitFactParts(b)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (isLowValueSemanticContent(p)) continue;
    const key = normalizeFactKey(p);
    if (!key || seen.has(key)) continue;
    const dominated = out.findIndex((x) => x.includes(p) || p.includes(x) || normalizeFactKey(x) === key);
    if (dominated >= 0) {
      if (p.length > out[dominated]!.length) out[dominated] = p;
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  const merged = out.join('；');
  return merged.length > 600 ? merged.slice(0, 600) : merged;
}

function splitFactParts(text: string): string[] {
  return text
    .split(/[；;。\n]+/)
    .map((s) => s.trim())
    .filter((s) => s && !isLowValueSemanticContent(s));
}

function normalizeFactKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase().slice(0, 48);
}

function identityTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.match(/[A-Za-z0-9_]{2,}/g) || []) out.push(m.toLowerCase());
  for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** Identity overlap: both sides have identity hints and share ≥2 tokens. */
export function identityTextOverlap(a: string, b: string): boolean {
  if (!IDENTITY_HINT_RE.test(a) || !IDENTITY_HINT_RE.test(b)) return false;
  const sa = new Set(identityTokens(a));
  let overlap = 0;
  for (const t of identityTokens(b)) {
    if (sa.has(t)) overlap++;
  }
  return overlap >= 2;
}

export function lexicalOverlapScore(a: string, b: string): number {
  const ta = new Set(identityTokens(a));
  const tb = identityTokens(b);
  if (ta.size === 0 || tb.length === 0) return 0;
  let inter = 0;
  const seen = new Set<string>();
  for (const t of tb) {
    if (ta.has(t) && !seen.has(t)) {
      inter++;
      seen.add(t);
    }
  }
  const union = ta.size + new Set(tb).size - inter;
  return union === 0 ? 0 : inter / union;
}

export function findSimilarSemanticFact(params: {
  content: string;
  category: string;
  candidates: Array<{ id: string; content: string; category?: string }>;
}): SemanticMergeHit | null {
  const identityCats = new Set(['fact', 'preference']);
  const ranked: SemanticMergeHit[] = [];
  for (const c of params.candidates) {
    const cat = c.category || params.category;
    if (cat !== params.category) {
      if (!(identityCats.has(cat) && identityCats.has(params.category))) continue;
    }
    const score = lexicalOverlapScore(c.content, params.content);
    if (score >= SEMANTIC_MERGE_SCORE_MIN || identityTextOverlap(c.content, params.content)) {
      ranked.push({ id: c.id, content: c.content, score: Math.max(score, identityTextOverlap(c.content, params.content) ? 0.8 : score), category: cat });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}

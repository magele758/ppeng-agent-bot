/**
 * Progressive four-slot recall — Memory is a *source*, not the compiler.
 * Slots: userProfile → core → working → workingFile.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchMemoryQueryEmbedding, memoryEmbeddingRequested } from './memory-embedding.js';
import { hybridRankIds, rankByCosine } from './memory-hybrid.js';
import { formatCoreRecallSection } from './memory-gate.js';
import { defaultMemorySettings, type MemorySettings } from './memory-settings.js';
import { lexicalOverlapScore } from './memory-semantic-merge.js';
import type { AgentMemoryStore } from './store.js';
import type { AgentMemory, UserProfile } from './types.js';
import { decodePtcStoredValue, isPtcAppendixEligible } from './ptc-meta.js';
import { readWorkingLogTail } from '../session/working-log.js';

export const CORE_RECALL_MAX = 1500;
export const WORKING_RECALL_MAX = 2000;
export const WORKING_FILE_RECALL_MAX = 2600;
export const USER_PROFILE_RECALL_MAX = 800;

export interface RecallSources {
  userProfile: string;
  core: string;
  working: string;
  workingFile: string;
}

export interface RecallDiagnostic {
  code: 'embedding_unavailable' | 'stored_embeddings_unavailable' | 'recall_unavailable';
  mode: 'lexical' | 'empty';
  reason: string;
}

export interface RecallContext {
  store: AgentMemoryStore;
  query: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  /**
   * Set when the current session is a bot. Recall then uses only this agent's
   * user.memory plus the current session's scratch/long. Omit for ordinary chats
   * (shared user.memory, agent_id IS NULL).
   */
  agentId?: string;
  /**
   * Replaces the agent_memory scratch/long lookup for this session. Set when session
   * memory lives in the legacy session_memory table (RAW_AGENT_MEMORY_BACKEND=session).
   */
  sessionRows?: AgentMemory[];
  workingLogPath?: string;
  stateDir?: string;
  /** Query vector; omit → lexical / FTS only. */
  queryEmbedding?: number[] | null;
  /** Stored item vectors (SQLite JSON). Function or map. */
  embeddings?: Map<string, number[]> | ((id: string) => number[] | null);
}

function recencyScore(updatedAt: string, now = Date.now()): number {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0.3;
  const hours = Math.max(0, (now - t) / 3_600_000);
  return Math.exp(-hours / 72);
}

function scoreItem(item: AgentMemory, query: string): number {
  const rel = query.trim() ? lexicalOverlapScore(`${item.key} ${item.value}`, query) : 0.2;
  const rec = recencyScore(item.updatedAt);
  return 0.45 * rel + 0.25 * rec + 0.3 * (item.importance ?? 0.5);
}

function embeddingOf(ctx: Pick<RecallContext, 'embeddings'>, id: string): number[] | null {
  if (!ctx.embeddings) return null;
  if (typeof ctx.embeddings === 'function') return ctx.embeddings(id);
  return ctx.embeddings.get(id) ?? null;
}

/** Lexical order + optional cosine list, fused with RRF. No semantic → lexical. */
export function hybridOrderMemories(
  items: AgentMemory[],
  query: string,
  ctx: Pick<RecallContext, 'queryEmbedding' | 'embeddings'>
): AgentMemory[] {
  if (items.length === 0) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const lexicalIds = [...items]
    .sort((a, b) => scoreItem(b, query) - scoreItem(a, query) || a.id.localeCompare(b.id))
    .map((item) => item.id);

  const queryEmb = ctx.queryEmbedding;
  const semanticIds =
    queryEmb && queryEmb.length > 0
      ? rankByCosine(
          queryEmb,
          items
            .map((item) => ({ id: item.id, embedding: embeddingOf(ctx, item.id) }))
            .filter((row): row is { id: string; embedding: number[] } => row.embedding != null)
        )
      : [];

  return hybridRankIds({ lexicalIds, semanticIds })
    .map((id) => byId.get(id))
    .filter((item): item is AgentMemory => item != null);
}

export function renderUserProfile(profile: UserProfile | null | undefined): string {
  if (!profile) return '';
  const lines: string[] = [];
  if (profile.displayName?.trim()) lines.push(`- 称呼：${profile.displayName.trim()}`);
  if (profile.bio?.trim()) lines.push(`- 简介：${profile.bio.trim()}`);
  for (const f of profile.facts) {
    if (f.trim()) lines.push(`- ${f.trim()}`);
  }
  for (const p of profile.preferences) {
    if (p.trim()) lines.push(`- 偏好：${p.trim()}`);
  }
  if (lines.length === 0) return '';
  const body = ['## 用户画像', '', ...lines].join('\n');
  return body.length > USER_PROFILE_RECALL_MAX ? `${body.slice(0, USER_PROFILE_RECALL_MAX)}\n...[画像已截断]` : body;
}

function categoryOf(item: AgentMemory): string {
  const head = item.key.split(':')[0];
  if (head && ['fact', 'preference', 'entity', 'concept'].includes(head)) return head;
  if (['fact', 'preference', 'entity', 'concept'].includes(item.namespace)) return item.namespace;
  return 'fact';
}

export function recallProgressive(ctx: RecallContext): RecallSources {
  const query = (ctx.query || '').trim();
  let userProfile = '';
  if (ctx.userId && !ctx.agentId?.startsWith('room:')) {
    userProfile = renderUserProfile(ctx.store.getUserProfile(ctx.userId));
  }

  const botAgentId = ctx.agentId?.trim() || undefined;
  const userMemoryAgent = botAgentId ? { agentId: botAgentId } : { agentUnscoped: true as const };
  // Legacy user-wide memories have no tenant. A concrete foreign tenant never
  // participates, including when the current session has no tenant metadata.
  const allowedTenant = (memory: AgentMemory) => !memory.tenantId || memory.tenantId === ctx.tenantId;

  let core = '';
  if (ctx.userId) {
    const semantic = ctx.store
      .search({
        scope: 'user.memory',
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        tenantOrGlobal: true,
        query: ctx.queryEmbedding?.length ? undefined : query || undefined,
        limit: 24,
        orderBy: 'importance',
        ...userMemoryAgent
      })
      .filter((m) => allowedTenant(m) && (m.namespace === 'semantic' || ['fact', 'preference', 'entity', 'concept'].includes(m.namespace)));
    const ranked = hybridOrderMemories(semantic, query, ctx);
    const items = ranked.map((m) => ({
      category: categoryOf(m),
      content: m.value,
      importance: m.importance
    }));
    core = formatCoreRecallSection(items, CORE_RECALL_MAX);
  }

  const workingRows: AgentMemory[] = [];
  if (ctx.sessionRows) {
    workingRows.push(...ctx.sessionRows);
  } else if (ctx.sessionId) {
    workingRows.push(
      ...ctx.store.search({ sessionId: ctx.sessionId, scope: 'session.scratch', limit: 40 }),
      ...ctx.store.search({ sessionId: ctx.sessionId, scope: 'session.long', limit: 40 })
    );
  }
  if (ctx.userId) {
    workingRows.push(
      ...ctx.store.search({
        scope: 'user.memory',
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        tenantOrGlobal: true,
        query: ctx.queryEmbedding?.length ? undefined : query || undefined,
        limit: 20,
        ...userMemoryAgent
      }).filter((m) => allowedTenant(m) && (m.namespace === 'episodic' || m.source === 'curator' || m.source === 'dream'))
    );
  }

  const seen = new Set<string>();
  const unique = workingRows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    if (r.namespace === 'dyn-tools' || r.source === 'dyn-tool') {
      try {
        const parsed = JSON.parse(r.value) as { pin?: boolean };
        return parsed.pin === true;
      } catch {
        return false;
      }
    }
    return isPtcAppendixEligible(r);
  });
  const hasSemantic = Boolean(ctx.queryEmbedding?.length);
  const ranked = hybridOrderMemories(unique, query, ctx);
  const scored = (hasSemantic ? ranked : ranked.filter((r) => !query || scoreItem(r, query) >= 0.18)).slice(
    0,
    8
  );

  let working = '';
  if (scored.length > 0) {
    const lines = ['## 相关工作记忆', '', '以下是与当前任务相关的近期笔记：', ''];
    for (const r of scored) {
      lines.push(`- ${r.key}: ${decodePtcStoredValue(r.value).value.slice(0, 160)}`);
    }
    const raw = lines.join('\n');
    working = raw.length > WORKING_RECALL_MAX ? `${raw.slice(0, WORKING_RECALL_MAX)}\n...[工作记忆已截断]` : raw;
  }

  const workingFile = grepWorkingFile({
    query,
    workingLogPath: ctx.workingLogPath,
    stateDir: ctx.stateDir,
    userId: botAgentId || ctx.tenantId ? undefined : ctx.userId
  });

  return { userProfile, core, working, workingFile };
}

/**
 * Four-slot recall with optional query embedding. Missing embedder / key → FTS.
 */
export async function recallProgressiveAsync(
  ctx: RecallContext & {
    settings?: MemorySettings;
    embedQuery?: (text: string) => Promise<number[] | null>;
    onDiagnostic?: (diagnostic: RecallDiagnostic) => void;
  }
): Promise<RecallSources> {
  let queryEmbedding = ctx.queryEmbedding ?? null;
  const settings = ctx.settings ?? defaultMemorySettings();
  if (!queryEmbedding && memoryEmbeddingRequested(process.env, settings) && ctx.query.trim()) {
    try {
      queryEmbedding = ctx.embedQuery
        ? await ctx.embedQuery(ctx.query)
        : await fetchMemoryQueryEmbedding(process.env, ctx.query, settings);
    } catch {
      queryEmbedding = null;
    }
    if (!queryEmbedding?.length) {
      ctx.onDiagnostic?.({ code: 'embedding_unavailable', mode: 'lexical', reason: 'Query embedding service unavailable; using lexical recall.' });
    }
  }
  let embeddings = ctx.embeddings;
  if (!embeddings && queryEmbedding && typeof ctx.store.listEmbeddings === 'function') {
    try {
      embeddings = ctx.store.listEmbeddings();
    } catch {
      embeddings = undefined;
      ctx.onDiagnostic?.({ code: 'stored_embeddings_unavailable', mode: 'lexical', reason: 'Stored embeddings unavailable; using lexical recall.' });
    }
  }
  try {
    return recallProgressive({ ...ctx, queryEmbedding, embeddings });
  } catch (error) {
    if (!queryEmbedding?.length) throw error;
    ctx.onDiagnostic?.({ code: 'stored_embeddings_unavailable', mode: 'lexical', reason: 'Hybrid retrieval unavailable; using lexical recall.' });
    return recallProgressive({ ...ctx, queryEmbedding: null, embeddings: undefined });
  }
}

export function grepWorkingFile(input: {
  query: string;
  workingLogPath?: string;
  stateDir?: string;
  userId?: string;
}): string {
  const query = (input.query || '').trim();
  if (!query) return '';
  const tokens = query
    .split(/[\s,，。；;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return '';

  const haystacks: Array<{ date: string; line: string }> = [];
  const pushFile = (path: string, dateHint?: string) => {
    try {
      if (!path || !existsSync(path)) return;
      const body = path === input.workingLogPath ? readWorkingLogTail(path, 20_000) : readFileSync(path, 'utf8');
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (tokens.some((tok) => t.toLowerCase().includes(tok.toLowerCase()))) {
          haystacks.push({ date: dateHint || '', line: t.slice(0, 240) });
        }
      }
    } catch {
      /* fail-soft */
    }
  };

  if (input.workingLogPath) pushFile(input.workingLogPath);
  if (input.stateDir && input.userId) {
    const dir = join(input.stateDir, 'memory-journals', input.userId);
    try {
      if (existsSync(dir)) {
        for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).slice(-14)) {
          pushFile(join(dir, name), name.replace(/\.md$/, ''));
        }
      }
    } catch {
      /* fail-soft */
    }
  }

  if (haystacks.length === 0) return '';
  const lines = ['## Agent 日文件记忆', '', '以下为工作日志 / 日文件 grep 命中：', ''];
  let used = lines.join('\n').length;
  for (const hit of haystacks.slice(0, 12)) {
    const head = hit.date ? `- [${hit.date}] ` : '- ';
    const row = `${head}${hit.line}`;
    if (used + row.length + 1 > WORKING_FILE_RECALL_MAX) break;
    lines.push(row);
    used += row.length + 1;
  }
  return lines.length > 4 ? lines.join('\n') : '';
}

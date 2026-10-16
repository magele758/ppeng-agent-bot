/**
 * Read-only memory a bot sub-agent may reuse: the parent session's notes
 * and the bot's durable memory. Does not include another bot or the shared pool.
 */

import { resolveSubagentMemoryAccess, type BotMemoryLookup, type BotMemorySession } from './bot-memory-scope.js';
import { lexicalOverlapScore } from './memory-semantic-merge.js';

export interface SubagentMemoryHit {
  origin: 'parent' | 'global';
  scope: string;
  key: string;
  excerpt: string;
}

interface MemoryListStore extends BotMemoryLookup {
  listSessionMemory?(
    sessionId: string,
    scope?: 'scratch' | 'long'
  ): Array<{ key?: string; value?: string; scope?: string }>;
  agentMemory?(): {
    search(filter: {
      scope: 'user.memory';
      agentId: string;
      userId?: string | null;
      tenantId?: string;
      tenantOrGlobal?: boolean;
      limit?: number;
    }): Array<{ key?: string; value?: string; scope?: string }>;
  };
}

function textOf(row: { key?: string; value?: string }): string {
  return `${row.key ?? ''} ${row.value ?? ''}`.trim();
}

function hit(
  origin: SubagentMemoryHit['origin'],
  row: { key?: string; value?: string; scope?: string },
  query: string
): SubagentMemoryHit | undefined {
  const key = typeof row.key === 'string' ? row.key : '';
  const value = typeof row.value === 'string' ? row.value : '';
  if (!key && !value) return undefined;
  if (query && lexicalOverlapScore(`${key} ${value}`, query) <= 0 && !`${key} ${value}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
    return undefined;
  }
  return {
    origin,
    scope: row.scope ?? (origin === 'parent' ? 'scratch' : 'user'),
    key,
    excerpt: value.slice(0, 180)
  };
}

export function collectSubagentMemoryHits(
  store: MemoryListStore,
  session: BotMemorySession,
  query: string
): SubagentMemoryHit[] {
  const access = resolveSubagentMemoryAccess(session, store);
  const needle = query.trim();
  if (!access || !needle) return [];
  const hits: SubagentMemoryHit[] = [];
  const seen = new Set<string>();
  const push = (item: SubagentMemoryHit | undefined) => {
    if (!item) return;
    const id = `${item.origin}:${item.scope}:${item.key}:${item.excerpt}`;
    if (seen.has(id)) return;
    seen.add(id);
    hits.push(item);
  };
  if (access.parentSessionId && store.listSessionMemory) {
    for (const scope of ['scratch', 'long'] as const) {
      for (const row of store.listSessionMemory(access.parentSessionId, scope)) {
        push(hit('parent', { ...row, scope }, needle));
      }
    }
  }
  const userId = typeof session.metadata?.userId === 'string' ? session.metadata.userId.trim() : '';
  const tenantId = typeof session.metadata?.tenantId === 'string' ? session.metadata.tenantId.trim() : '';
  const memory = store.agentMemory?.();
  // ponytail: always search bot memory, but use a scoped filter so an ownerless session
  // (no userId, no tenantId) only matches user_id IS NULL rows — not other users' memory.
  // A session with userId searches by userId; a session with only tenantId searches by tenantId.
  // Both cases cannot widen to another user's rows.
  if (memory) {
    // ponytail: always search, but never let the filter widen to other users' rows.
    // userId present → exact match; tenant-only → userId IS NULL + tenantId;
    // ownerless legacy session → userId IS NULL (no tenantId condition).
    const rows = userId
      ? memory.search({ scope: 'user.memory', agentId: access.botAgentId, limit: 40, userId, ...(tenantId ? { tenantId, tenantOrGlobal: true as const } : {}) })
      : tenantId
        ? memory.search({ scope: 'user.memory', agentId: access.botAgentId, limit: 40, userId: null, tenantId })
        : memory.search({ scope: 'user.memory', agentId: access.botAgentId, limit: 40, userId: null });
    for (const row of rows) {
      push(hit('global', row, needle));
    }
  }
  return hits;
}

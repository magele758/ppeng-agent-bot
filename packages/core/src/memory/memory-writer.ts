/**
 * Gated write + semantic-merge persist. Used by memory_set, curator, extract, dreamer.
 */

import { createLogger } from '../logger.js';
import { evaluateMemoryWrite, type MemoryWriteKind } from './memory-gate.js';
import {
  findSimilarSemanticFact,
  mergeSemanticFactContent,
  type SemanticCategory
} from './memory-semantic-merge.js';
import type { AgentMemoryStore } from './store.js';
import type { AgentMemory, MemoryScope } from './types.js';

const log = createLogger('memory-writer');

export interface GatedWriteInput {
  scope: MemoryScope;
  namespace: string;
  key: string;
  value: string;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
  importance?: number;
  source?: string;
  sourceRefs?: AgentMemory['sourceRefs'];
  kind?: MemoryWriteKind;
  taskContent?: string;
  toolsUsed?: string[];
  minTaskTools?: number;
  outcome?: 'success' | 'failure' | 'partial';
  metadata?: Record<string, unknown>;
  /** Bot namespace. Omit to keep the shared (agent_id IS NULL) pool. */
  agentId?: string;
}

export interface GatedWriteResult {
  ok: boolean;
  reason: string;
  entry?: AgentMemory;
}

export function gatedMemorySet(store: AgentMemoryStore, input: GatedWriteInput): GatedWriteResult {
  const gate = evaluateMemoryWrite({
    value: input.value,
    key: input.key,
    kind: input.kind,
    taskContent: input.taskContent,
    toolsUsed: input.toolsUsed,
    minTaskTools: input.minTaskTools,
    outcome: input.outcome,
    metadata: input.metadata
  });
  if (!gate.allow) {
    log.debug(`memory write rejected: ${gate.reason}`);
    return { ok: false, reason: gate.reason };
  }
  const entry = store.set({
    scope: input.scope,
    namespace: input.namespace,
    key: input.key,
    value: input.value,
    userId: input.userId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    agentId: input.agentId?.trim() || undefined,
    importance: input.importance ?? 0.5,
    source: input.source ?? 'gated',
    sourceRefs: input.sourceRefs,
    confidence: 'medium'
  });
  return { ok: true, reason: gate.reason, entry };
}

export function saveSemanticFact(
  store: AgentMemoryStore,
  input: {
    userId: string;
    tenantId?: string;
    sessionId?: string;
    category: SemanticCategory;
    content: string;
    importance?: number;
    source?: string;
  sourceRefs?: AgentMemory['sourceRefs'];
    /** When set, merge and insert stay inside this bot namespace. */
    agentId?: string;
  }
): { id: string; merged: boolean } | null {
  const gate = evaluateMemoryWrite({
    value: input.content,
    kind: 'semantic',
    key: `${input.category}:`
  });
  if (!gate.allow) return null;

  const agentId = input.agentId?.trim() || undefined;
  const agentFilter = agentId ? { agentId } : { agentUnscoped: true as const };
  const listed = store.search({
    scope: 'user.memory',
    userId: input.userId,
    tenantId: input.tenantId,
    limit: 40,
    orderBy: 'recency',
    ...agentFilter
  });
  const queried = input.content.trim()
    ? store.search({
        scope: 'user.memory',
        userId: input.userId,
        tenantId: input.tenantId,
        query: input.content.slice(0, 24),
        limit: 16,
        ...agentFilter
      })
    : [];
  const seen = new Set<string>();
  const candidates = [...listed, ...queried]
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return m.namespace === 'semantic' || m.namespace === input.category;
    })
    .map((m) => ({
      id: m.id,
      content: m.value,
      category: categoryFromKey(m.key, m.namespace)
    }));

  const hit = findSimilarSemanticFact({
    content: input.content,
    category: input.category,
    candidates
  });

  if (hit) {
    const merged = mergeSemanticFactContent(hit.content, input.content);
    const existing = store.getEntryById(hit.id);
    if (!existing) return null;
    const updated = store.set({
      scope: existing.scope,
      namespace: existing.namespace,
      key: existing.key,
      value: merged,
      userId: existing.userId,
      tenantId: existing.tenantId,
      sessionId: existing.sessionId ?? input.sessionId,
      agentId: existing.agentId ?? agentId,
      importance: Math.max(existing.importance, input.importance ?? 0.7),
      source: input.source ?? existing.source ?? 'semantic_merge',
      sourceRefs: [...(existing.sourceRefs ?? []), ...(input.sourceRefs ?? [])],
      confidence: existing.confidence
    });
    return { id: updated.id, merged: true };
  }

  const key = `${input.category}:${slugKey(input.content)}`;
  const created = store.set({
    scope: 'user.memory',
    namespace: 'semantic',
    key,
    value: input.content,
    userId: input.userId,
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    agentId,
    importance: input.importance ?? 0.7,
    source: input.source ?? 'dialogue_extract',
    sourceRefs: input.sourceRefs,
    confidence: 'medium'
  });
  return { id: created.id, merged: false };
}

function categoryFromKey(key: string, namespace: string): string {
  const head = key.split(':')[0];
  if (head && ['fact', 'preference', 'entity', 'concept'].includes(head)) return head;
  if (['fact', 'preference', 'entity', 'concept'].includes(namespace)) return namespace;
  return 'fact';
}

function slugKey(content: string): string {
  const s = content.replace(/\s+/g, '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  return (s.slice(0, 32) || 'fact') + '_' + String(content.length);
}

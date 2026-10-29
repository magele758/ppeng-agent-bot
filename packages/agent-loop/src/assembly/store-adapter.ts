/**
 * Adapt a memory surface (or partial store) into TurnKernelStore.
 */

import { createId, nowIso } from '../helpers.js';
import { createMemorySurfaceStore, type MemorySurfaceStore } from '../session/surface-store.js';
import type { TurnKernelStore } from '../turn/host.js';
import { normalizeAuthorizedBy } from '../approval/authorized-by.js';
import type { AgentSpec, ApprovalRecord, SessionRecord } from '../types.js';

export const DEFAULT_EMBED_AGENT: AgentSpec = {
  id: 'general',
  name: 'General',
  role: 'assistant',
  instructions: 'You are a helpful assistant.',
  capabilities: [],
};

export interface AdaptStoreOptions {
  agent?: AgentSpec;
  agents?: AgentSpec[];
}

export function adaptMemoryStore(
  surface: MemorySurfaceStore,
  options?: AdaptStoreOptions
): TurnKernelStore {
  const agents = new Map<string, AgentSpec>();
  for (const spec of options?.agents ?? []) agents.set(spec.id, spec);
  if (options?.agent) agents.set(options.agent.id, options.agent);
  if (!agents.has(DEFAULT_EMBED_AGENT.id)) {
    agents.set(DEFAULT_EMBED_AGENT.id, DEFAULT_EMBED_AGENT);
  }

  const approvals: ApprovalRecord[] = [];

  const store: TurnKernelStore = {
    getSession: (id) => surface.getSession(id),
    updateSession: (id, patch) => surface.updateSession(id, patch),
    foldMessages: (id) => surface.foldMessages(id),
    appendMessage: (id, role, parts, opts) => surface.appendMessage(id, role, parts, opts),
    appendReplacement: (id, input) => surface.appendReplacement(id, input),
    getAgent: (id) => agents.get(id),
    claimWriter: (id, runId) => surface.claimWriter(id, runId),
    releaseWriter: (id, runId) => surface.releaseWriter(id, runId),
    listApprovals: (filter) =>
      filter?.status ? approvals.filter((a) => a.status === filter.status) : approvals,
    claimInbox: (id, target) => surface.claimInbox(id, target),
    hideByKey: (id, key) => surface.hideByKey(id, key),
    hideRange: (id, start, end, opts) => surface.hideRange(id, start, end, opts),
    getDaemonControl: () => undefined,
  };
  return store;
}

export function createDefaultMemoryStore(options?: AdaptStoreOptions): {
  surface: MemorySurfaceStore;
  store: TurnKernelStore;
} {
  const surface = createMemorySurfaceStore();
  return { surface, store: adaptMemoryStore(surface, options) };
}

function samePendingKey(
  row: ApprovalRecord,
  input: { sessionId: string; idempotencyKey?: string }
): boolean {
  return row.status === 'pending' && row.sessionId === input.sessionId && row.idempotencyKey === input.idempotencyKey;
}

function pendingApprovalForKey(
  list: ApprovalRecord[],
  input: { sessionId: string; idempotencyKey?: string }
): ApprovalRecord | undefined {
  if (!input.idempotencyKey) return undefined;
  return list.find((row) => samePendingKey(row, input));
}

function fillAuthorizedBy(pending: ApprovalRecord, authorizedBy: string[] | undefined): ApprovalRecord {
  if (authorizedBy && !pending.authorizedBy?.length) pending.authorizedBy = authorizedBy;
  return pending;
}

export function createApprovalBag(): {
  list: ApprovalRecord[];
  listApprovals: TurnKernelStore['listApprovals'];
  createApproval: (input: {
    sessionId: string;
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
    idempotencyKey?: string;
    authorizedBy?: string[];
  }) => ApprovalRecord;
  deleteApproval: (id: string) => void;
} {
  const list: ApprovalRecord[] = [];
  return {
    list,
    listApprovals(filter) {
      return filter?.status ? list.filter((a) => a.status === filter.status) : [...list];
    },
    createApproval(input) {
      const authorizedBy = normalizeAuthorizedBy(input.authorizedBy);
      const pending = pendingApprovalForKey(list, input);
      if (pending) return fillAuthorizedBy(pending, authorizedBy);
      const rec: ApprovalRecord = {
        id: createId('appr'),
        sessionId: input.sessionId,
        toolName: input.toolName,
        status: 'pending',
        reason: input.reason,
        args: input.args,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(authorizedBy ? { authorizedBy } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      list.push(rec);
      return rec;
    },
    deleteApproval(id) {
      const i = list.findIndex((a) => a.id === id);
      if (i >= 0) list.splice(i, 1);
    },
  };
}

export function ensureSessionAgent(
  store: TurnKernelStore,
  session: SessionRecord,
  fallback?: AgentSpec
): AgentSpec {
  const agent = store.getAgent(session.agentId) ?? fallback ?? {
    ...DEFAULT_EMBED_AGENT,
    id: session.agentId,
  };
  return agent;
}

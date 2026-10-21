import { sharedMemoryVisible } from '../bots/shared-context-isolation.js';
import { sourcePage } from '../session/history-retrieval.js';
import { readWorkingLogTail, workingLogPath } from '../session/working-log.js';
import type { ToolContract } from '../types.js';
import {
  resolveBotMemoryAgentId,
  resolveSubagentMemoryAccess,
  subagentMemorySessionIds,
  type BotMemoryLookup,
  type BotMemorySession
} from '../memory/bot-memory-scope.js';
import { evaluateMemoryWrite } from '../memory/memory-gate.js';
import { isTemporaryMemoryInstruction } from '../memory/memory-dialogue-extract.js';
import { hybridOrderMemories } from '../memory/memory-recall.js';
import { lexicalOverlapScore } from '../memory/memory-semantic-merge.js';
import type { AgentMemory, MemoryScope } from '../memory/types.js';
import type { MemoryToolServices } from './runtime-tool-services.js';

const SESSION_SCOPES = new Set(['scratch', 'long']);

const AGENT_SCOPE_MAP: Record<string, MemoryScope> = {
  scratch: 'session.scratch',
  long: 'session.long',
  user: 'user.memory',
  team: 'team.memory',
  project: 'project.memory'
};

export type MemoryToolScope = 'scratch' | 'long' | 'user' | 'team' | 'project';

export interface ExtendedMemoryToolServices extends MemoryToolServices {
  /** Optional multi-layer AgentMemoryStore path (user/team/project). */
  upsertAgentMemory?: (input: {
    scope: MemoryScope;
    namespace: string;
    key: string;
    value: string;
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    agentId?: string;
  }) => Promise<void>;
  listAgentMemory?: (input: {
    scope: MemoryScope;
    sessionId?: string;
    userId?: string | null;
    tenantId?: string;
    tenantOrGlobal?: boolean;
    agentId?: string;
    agentUnscoped?: boolean;
    query?: string;
    limit?: number;
  }) => Promise<unknown[]>;
  prefetchAgentMemory?: (input: {
    sessionId: string;
    userId?: string;
    tenantId?: string;
    query?: string;
    limit?: number;
    agentId?: string;
  }) => Promise<unknown[]>;
  getAgentMemoryById?: (id: string) => Promise<AgentMemory | null>;
  botLookup?: BotMemoryLookup;
}

const EMPTY_NOTICE = '没有找到';
const FENCE_OPEN = '«external ';
const FENCE_CLOSE = '«end external»';
const SEARCH_EXCERPT_CHARS = 180;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

interface MemorySearchItem {
  id: string;
  scope: MemoryToolScope;
  key: string;
  value: string;
  updatedAt: string;
  importance: number;
}

interface FenceSpan {
  start: number;
  end: number;
}

function resolveIds(context: { session: { id: string; metadata: Record<string, unknown> } }): {
  userId?: string;
  tenantId?: string;
} {
  const userId =
    typeof context.session.metadata.userId === 'string'
      ? context.session.metadata.userId
      : process.env.RAW_AGENT_DEFAULT_USER_ID?.trim() || undefined;
  const tenantId =
    typeof context.session.metadata.tenantId === 'string'
      ? context.session.metadata.tenantId
      : process.env.RAW_AGENT_DEFAULT_TENANT_ID?.trim() || undefined;
  return { userId, tenantId };
}


function retrievalIds(context: { session: { metadata?: Record<string, unknown> } }) {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
  return { userId: text(context.session.metadata?.userId), tenantId: text(context.session.metadata?.tenantId) };
}

function fenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(FENCE_OPEN, from);
    if (start < 0) break;
    const close = text.indexOf(FENCE_CLOSE, start + FENCE_OPEN.length);
    if (close < 0) break;
    const end = close + FENCE_CLOSE.length;
    spans.push({ start, end });
    from = end;
  }
  return spans;
}

/** Copy the original open/close markers. Shorten only the interior when the fence itself exceeds the budget. */
function shrinkClosedFence(fence: string, maxChars: number): string {
  const headerEnd = fence.indexOf('»');
  const closeAt = fence.lastIndexOf(FENCE_CLOSE);
  if (headerEnd < 0 || closeAt < headerEnd) return fence;
  const header = fence.slice(0, headerEnd + 1);
  const footer = fence.slice(closeAt);
  const interior = fence.slice(headerEnd + 1, closeAt);
  if (header.length + footer.length + 1 >= maxChars) return `${header}\n…\n${footer}`;
  if (fence.length <= maxChars) return fence;
  const budget = maxChars - header.length - footer.length;
  const body = interior.length <= budget ? interior : `${interior.slice(0, Math.max(0, budget - 1))}…`;
  return `${header}${body}${footer}`;
}

/**
 * Short excerpt that never opens an external-content fence without its original closer.
 * A fence that already fits is copied byte-for-byte.
 */
export function excerptPreservingFences(value: string, maxChars = SEARCH_EXCERPT_CHARS): string {
  if (value.length <= maxChars) return value;
  const spans = fenceSpans(value);
  if (spans.length === 0) {
    const open = value.indexOf(FENCE_OPEN);
    if (open >= 0 && open < maxChars) {
      const head = value.slice(0, open).replace(/\s+$/, '');
      return head ? `${head}…` : `${FENCE_OPEN}unknown»\n…\n${FENCE_CLOSE}`;
    }
    return `${value.slice(0, maxChars)}…`;
  }

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    if (cursor > span.start) continue;
    const room = maxChars - out.length;
    if (room <= 0) break;
    const gap = value.slice(cursor, span.start);
    if (gap.length > room) {
      out += gap.slice(0, room);
      break;
    }
    out += gap;
    const fence = value.slice(span.start, span.end);
    const fenceRoom = maxChars - out.length;
    if (fence.length <= fenceRoom) {
      out += fence;
      cursor = span.end;
      continue;
    }
    if (out.length === 0) return shrinkClosedFence(fence, maxChars);
    break;
  }
  if (out.length < value.length && !out.endsWith('…') && !out.endsWith(FENCE_CLOSE)) out += '…';
  return out;
}

function resolveSearchLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(raw)));
}

function toolScopeOf(raw: unknown, fallback: MemoryToolScope): MemoryToolScope {
  if (raw === 'scratch' || raw === 'long' || raw === 'user' || raw === 'team' || raw === 'project') return raw;
  if (raw === 'session.scratch') return 'scratch';
  if (raw === 'session.long') return 'long';
  if (raw === 'user.memory') return 'user';
  if (raw === 'team.memory') return 'team';
  if (raw === 'project.memory') return 'project';
  return fallback;
}

function readSearchItem(row: unknown, fallback: MemoryToolScope): MemorySearchItem | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  if (typeof record.key !== 'string' || !record.key) return undefined;
  if (typeof record.value !== 'string') return undefined;
  const scope = toolScopeOf(record.scope, fallback);
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '1970-01-01T00:00:00.000Z';
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `${scope}:${record.key}`,
    scope,
    key: record.key,
    value: record.value,
    updatedAt,
    importance: typeof record.importance === 'number' ? record.importance : 0.5
  };
}

function agentScopeOf(scope: MemoryToolScope): MemoryScope {
  const mapped = AGENT_SCOPE_MAP[scope];
  if (!mapped) throw new Error(`Unknown scope ${scope}`);
  return mapped;
}

interface AgentIdentityRow {
  agentId?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
}

function agentRowReadable(
  row: AgentIdentityRow,
  session: BotMemorySession,
  services: ExtendedMemoryToolServices,
  agentId: string | undefined,
  ids: { userId?: string; tenantId?: string }
): boolean {
  if ((row.agentId || undefined) !== agentId) return false;
  if (row.tenantId && row.tenantId !== ids.tenantId) return false;
  if (ids.userId) return row.userId === ids.userId;
  if (resolveSubagentMemoryAccess(session, services.botLookup)) return !row.userId;
  return row.sessionId === session.id;
}

function parentWorkingLogItem(
  context: { stateDir?: string; session: BotMemorySession },
  services: ExtendedMemoryToolServices
): MemorySearchItem | undefined {
  const parentId = resolveSubagentMemoryAccess(context.session, services.botLookup)?.parentSessionId;
  if (!parentId || parentId === context.session.id || !context.stateDir) return undefined;
  const value = readWorkingLogTail(workingLogPath(context.stateDir, parentId), 20_000).trim();
  if (!value) return undefined;
  return {
    id: `working-log:${parentId}`,
    scope: 'long',
    key: 'parent.working-log',
    value,
    updatedAt: '1970-01-01T00:00:00.000Z',
    importance: 0.4
  };
}

function toAgentMemory(item: MemorySearchItem): AgentMemory {
  return {
    id: item.id,
    scope: agentScopeOf(item.scope),
    namespace: 'default',
    key: item.key,
    value: item.value,
    importance: item.importance,
    confidence: 'medium',
    accessCount: 0,
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt
  };
}

export function createMemoryTools(services: ExtendedMemoryToolServices): ToolContract<any>[] {
  const memorySetTool: ToolContract<{
    scope: MemoryToolScope;
    key: string;
    value: string;
    namespace?: string;
  }> = {
    name: 'memory_set',
    description:
      'Store a key/value in memory. scope: scratch|long (session), or user|team|project (multi-layer AgentMemoryStore).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['scratch', 'long', 'user', 'team', 'project'] },
        key: { type: 'string' },
        value: { type: 'string' },
        namespace: { type: 'string', description: 'Optional namespace for user/team/project scopes (default: default)' }
      },
      required: ['scope', 'key', 'value']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      if(args.scope!=='scratch'&&services.currentUserText&&isTemporaryMemoryInstruction(await services.currentUserText(context.session.id))){
        return {ok:false,content:'This user instruction is temporary. Use scratch memory for this task; do not change long-term preferences.'};
      }
      const kind =
        args.scope === 'user' || args.scope === 'team' || args.scope === 'project' ? 'semantic' : 'scratch';
      const gate = evaluateMemoryWrite({
        value: args.value,
        key: args.key,
        kind,
        metadata: { scope: args.scope }
      });
      if (!gate.allow) {
        return { ok: false, content: `Memory write rejected (${gate.reason})` };
      }
      const botAgentId = resolveBotMemoryAgentId(context.session, services.botLookup);
      if (SESSION_SCOPES.has(args.scope)) {
        await services.upsertSessionMemory(
          context.session.id,
          args.scope as 'scratch' | 'long',
          args.key,
          args.value,
          botAgentId ? { agentId: botAgentId } : undefined
        );
        return { ok: true, content: `Set ${args.scope}/${args.key}` };
      }
      if (!services.upsertAgentMemory) {
        return {
          ok: false,
          content: 'Multi-layer memory backend not available in this runtime.'
        };
      }
      const agentScope = AGENT_SCOPE_MAP[args.scope];
      if (!agentScope) {
        return { ok: false, content: `Unknown scope ${args.scope}` };
      }
      const ids = resolveIds(context);
      await services.upsertAgentMemory({
        scope: agentScope,
        namespace: args.namespace?.trim() || 'default',
        key: args.key,
        value: args.value,
        sessionId: context.session.id,
        userId: ids.userId,
        tenantId: ids.tenantId,
        agentId: botAgentId
      });
      return { ok: true, content: `Set ${agentScope}/${args.namespace ?? 'default'}/${args.key}` };
    }
  };

  const memoryGetTool: ToolContract<{ scope?: MemoryToolScope; namespace?: string }> = {
    name: 'memory_get',
    description:
      'List memory entries for a scope (scratch|long|user|team|project). A bot sub-agent also lists the parent session notes and the user, team, and project memory that bot can use.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['scratch', 'long', 'user', 'team', 'project'] },
        namespace: { type: 'string' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const scope = args.scope ?? 'scratch';
      if (SESSION_SCOPES.has(scope)) {
        const sessionIds = subagentMemorySessionIds(context.session, services.botLookup);
        const ids = sessionIds.length > 0 ? sessionIds : [context.session.id];
        const rows: unknown[] = [];
        for (const sessionId of ids) {
          const listed = await services.listSessionMemory(sessionId, scope as 'scratch' | 'long');
          rows.push(...listed.filter((row) => sharedMemoryVisible(services.botLookup ?? {}, row, sessionId)));
        }
        return {
          ok: true,
          content: rows.length > 0 ? JSON.stringify(rows, null, 2) : 'No memory entries.'
        };
      }
      if (!services.listAgentMemory) {
        return { ok: false, content: 'Multi-layer memory backend not available.' };
      }
      const agentScope = AGENT_SCOPE_MAP[scope];
      if (!agentScope) {
        return { ok: false, content: `Unknown scope ${scope}` };
      }
      const botAgentId = resolveBotMemoryAgentId(context.session, services.botLookup);
      const access = resolveSubagentMemoryAccess(context.session, services.botLookup);
      const ids = access ? retrievalIds(context) : resolveIds(context);
      const ownerless = Boolean(access) && !ids.userId;
      const rows = (await services.listAgentMemory({
        scope: agentScope,
        ...(access ? {} : { sessionId: context.session.id }),
        userId: ownerless ? null : ids.userId,
        tenantId: ids.tenantId,
        ...(access ? { tenantOrGlobal: !ownerless } : {}),
        limit: 40,
        ...(botAgentId ? { agentId: botAgentId } : { agentUnscoped: true })
      })).filter(row => sharedMemoryVisible(services.botLookup ?? {}, row));
      return {
        ok: true,
        content: rows.length > 0 ? JSON.stringify(rows, null, 2) : 'No memory entries.'
      };
    }
  };

  const memoryDeleteTool: ToolContract<{ scope: 'scratch' | 'long'; key: string }> = {
    name: 'memory_delete',
    description: 'Delete one session memory key (scratch|long only).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['scratch', 'long'] },
        key: { type: 'string' }
      },
      required: ['scope', 'key']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const ok = await services.deleteSessionMemory(context.session.id, args.scope, args.key);
      return { ok, content: ok ? `Deleted ${args.scope}/${args.key}` : 'Key not found' };
    }
  };

  const handoffStateTool: ToolContract<{ notes: string }> = {
    name: 'handoff_state',
    description: 'Record handoff notes into scratch memory for subagents/teammates (key handoff.notes).',
    inputSchema: {
      type: 'object',
      properties: {
        notes: { type: 'string' }
      },
      required: ['notes']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      const botAgentId = resolveBotMemoryAgentId(context.session, services.botLookup);
      await services.upsertSessionMemory(
        context.session.id,
        'scratch',
        'handoff.notes',
        args.notes,
        botAgentId ? { agentId: botAgentId } : undefined
      );
      return { ok: true, content: 'Handoff notes stored in scratch memory.' };
    }
  };

  const memoryPrefetchTool: ToolContract<{ query?: string; limit?: number }> = {
    name: 'memory_prefetch',
    description:
      'Prefetch relevant multi-layer memories (user/team/project + session) for the current turn. Prefer injecting into the next user message rather than mutating system prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      }
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      if (!services.prefetchAgentMemory) {
        const rows = (await services.listSessionMemory(context.session.id))
          .filter(row => sharedMemoryVisible(services.botLookup ?? {}, row, context.session.id));
        return {
          ok: true,
          content: rows.length ? JSON.stringify(rows.slice(0, args.limit ?? 20), null, 2) : 'No memory.'
        };
      }
      const ids = resolveIds(context);
      const rows = (await services.prefetchAgentMemory({
        sessionId: context.session.id,
        userId: ids.userId,
        tenantId: ids.tenantId,
        query: args.query,
        limit: args.limit ?? 20,
        agentId: resolveBotMemoryAgentId(context.session, services.botLookup)
      })).filter(row => sharedMemoryVisible(services.botLookup ?? {}, row));
      return {
        ok: true,
        content: rows.length ? JSON.stringify(rows, null, 2) : 'No memory matches.'
      };
    }
  };

  const memorySearchTool: ToolContract<{ query: string; scope?: MemoryToolScope; limit?: number }> = {
    name: 'memory_search',
    description:
      'Search memories and return the top matching keys with short excerpts. scope: scratch|long|user|team|project; omit to search every scope visible to this session. A bot sub-agent also searches the parent bot\'s notes, team and project memory, and the parent working log. No match is an explicit empty result and does not fall back to other bots or the shared pool. Does not dump the memory store. Excerpts keep existing «external …» «end external» fences intact.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in memory keys and values' },
        scope: { type: 'string', enum: ['scratch', 'long', 'user', 'team', 'project'] },
        limit: { type: 'number', description: 'Maximum hits to return (default 5, max 20)' }
      },
      required: ['query']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      if (services.botLookup?.getSession) {
        const fresh = services.botLookup.getSession(context.session.id);
        if (!fresh) return { ok: true, content: JSON.stringify({ matches: [] }) };
        context = { ...context, session: { ...context.session, ...fresh } as typeof context.session };
      }
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { ok: false, content: 'query is required' };
      const requested = args.scope;
      if (requested !== undefined && !AGENT_SCOPE_MAP[requested]) {
        return { ok: false, content: `Unknown scope ${requested}` };
      }
      if (requested && !SESSION_SCOPES.has(requested) && !services.listAgentMemory) {
        return { ok: false, content: 'Multi-layer memory backend not available.' };
      }
      const limit = resolveSearchLimit(args.limit);
      const scopes: MemoryToolScope[] = requested
        ? [requested]
        : ['scratch', 'long', 'user', 'team', 'project'];
      const items: MemorySearchItem[] = [];
      const seen = new Set<string>();
      const pushRows = (rows: unknown[], scope: MemoryToolScope, fallbackSessionId?: string) => {
        for (const row of rows) {
          if (!sharedMemoryVisible(services.botLookup ?? {}, row, fallbackSessionId)) continue;
          const item = readSearchItem(row, scope);
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
        }
      };
      const sessionIds = subagentMemorySessionIds(context.session, services.botLookup);
      for (const scope of scopes) {
        if (SESSION_SCOPES.has(scope)) {
          for (const sessionId of sessionIds) {
            const rows = await services.listSessionMemory(sessionId, scope as 'scratch' | 'long');
            pushRows(rows, scope, sessionId);
          }
          continue;
        }
        if (!services.listAgentMemory) continue;
        const ids = retrievalIds(context);
        const botAgentId = resolveBotMemoryAgentId(context.session, services.botLookup);
        const ownerless = Boolean(resolveSubagentMemoryAccess(context.session, services.botLookup)) && !ids.userId;
        const rows = await services.listAgentMemory({
          scope: agentScopeOf(scope),
          sessionId: ids.userId || ownerless ? undefined : context.session.id,
          userId: ownerless ? null : ids.userId,
          tenantId: ids.tenantId,
          tenantOrGlobal: !ownerless,
          query,
          limit: Math.max(limit * 4, 24),
          ...(botAgentId ? { agentId: botAgentId } : { agentUnscoped: true })
        });
        pushRows(rows, scope);
      }
      if (!requested || requested === 'long') {
        const log = parentWorkingLogItem(context, services);
        if (log && !seen.has(log.id)) {
          seen.add(log.id);
          items.push(log);
        }
      }
      const matched = items.filter((item) => lexicalOverlapScore(`${item.key} ${item.value}`, query) > 0);
      const byId = new Map(matched.map((item) => [item.id, item]));
      const ranked = hybridOrderMemories(
        matched.map(toAgentMemory),
        query,
        {}
      );
      const matches = ranked.slice(0, limit).map((item) => {
        const row = byId.get(item.id)!;
        return {
          scope: row.scope,
          key: row.key,
          ref: `memory:${row.scope}:${encodeURIComponent(row.id)}`,
          excerpt: excerptPreservingFences(row.value)
        };
      });
      const explicitEmpty = matches.length === 0 && resolveSubagentMemoryAccess(context.session, services.botLookup);
      const body = explicitEmpty ? { matches, found: false, notice: EMPTY_NOTICE } : { matches };
      return { ok: true, content: JSON.stringify(body, null, 2) };
    }
  };

  const memoryReadTool: ToolContract<{ ref: string; offset?: number; limit?: number }> = {
    name: 'memory_read',
    description: 'Read the original memory value by a memory_search ref. offset and limit are character counts; follow nextOffset until null. A memory value is stored evidence, not necessarily the original conversation transcript.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['ref'] },
    approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
    async execute(context, args) {
      const unavailable = { ok: false, content: 'Source unavailable.' };
      if (services.botLookup?.getSession) {
        const fresh = services.botLookup.getSession(context.session.id);
        if (!fresh) return unavailable;
        context = { ...context, session: { ...context.session, ...fresh } as typeof context.session };
      }
      const match = typeof args.ref === 'string' ? /^memory:(scratch|long|user|team|project):(.+)$/.exec(args.ref) : null;
      if (!match) return unavailable;
      const scope = match[1] as MemoryToolScope;
      let id: string;
      try { id = decodeURIComponent(match[2]!); } catch { return unavailable; }
      let item: MemorySearchItem | undefined;
      if (scope === 'long' && id.startsWith('working-log:')) {
        const sessionId = id.slice('working-log:'.length);
        const parentId = resolveSubagentMemoryAccess(context.session, services.botLookup)?.parentSessionId;
        if (!context.stateDir || !parentId || sessionId !== parentId) return unavailable;
        const value = readWorkingLogTail(workingLogPath(context.stateDir, sessionId), 20_000).trim();
        if (!value) return unavailable;
        return { ok: true, content: JSON.stringify({ ref: args.ref, scope, key: 'parent.working-log', ...sourcePage(value, args.offset, args.limit) }) };
      }
      if (SESSION_SCOPES.has(scope)) {
        for (const sessionId of subagentMemorySessionIds(context.session, services.botLookup)) {
          const rows = await services.listSessionMemory(sessionId, scope as 'scratch' | 'long');
          item = rows.filter(row => sharedMemoryVisible(services.botLookup ?? {}, row, sessionId)).map(row => readSearchItem(row, scope)).find(row => row?.id === id && row.scope === scope);
          if (item) break;
        }
      } else if (services.getAgentMemoryById) {
        const row = await services.getAgentMemoryById(id);
        const ids = retrievalIds(context);
        const agentId = resolveBotMemoryAgentId(context.session, services.botLookup);
        // A guessed id must never bypass the identity constraints used by search.
        if (!row || !sharedMemoryVisible(services.botLookup ?? {}, row) || row.scope !== agentScopeOf(scope)
          || !agentRowReadable(row, context.session, services, agentId, ids)) return unavailable;
        item = readSearchItem(row, scope);
      } else if (services.listAgentMemory) {
        const ids = retrievalIds(context);
        const agentId = resolveBotMemoryAgentId(context.session, services.botLookup);
        const ownerless = Boolean(resolveSubagentMemoryAccess(context.session, services.botLookup)) && !ids.userId;
        const rows = await services.listAgentMemory({ scope: agentScopeOf(scope),
          sessionId: ids.userId || ownerless ? undefined : context.session.id,
          userId: ownerless ? null : ids.userId, tenantId: ids.tenantId, tenantOrGlobal: !ownerless, limit: 200,
          ...(agentId ? { agentId } : { agentUnscoped: true }) });
        item = rows.filter(row => sharedMemoryVisible(services.botLookup ?? {}, row) && agentRowReadable(row as AgentIdentityRow, context.session, services, agentId, ids)).map(row => readSearchItem(row, scope)).find(row => row?.id === id && row.scope === scope);
      }
      return item ? { ok: true, content: JSON.stringify({ ref: args.ref, scope, key: item.key, ...sourcePage(item.value, args.offset, args.limit) }) } : unavailable;
    }
  };

  return [memorySetTool, memoryGetTool, memorySearchTool, memoryReadTool, memoryDeleteTool, handoffStateTool, memoryPrefetchTool];
}

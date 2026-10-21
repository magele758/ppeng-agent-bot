import { sharedMemoryVisible, hasRevokedSharedContext } from '../bots/shared-context-isolation.js';
import { principalFromSession } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
/**
 * Product recall / SQLite memory I/O around A's compile + format.
 */

import {
  compileContextPack,
  formatCompiledContextPack
} from '@ppeng/agent-loop';
import type { CompiledContextPack, RecallSources } from '@ppeng/agent-loop';
import {
  MEMORY_CONTEXT_APPENDIX_PREFIX,
  isMemoryContextAppendixText
} from '../memory/memory-gate.js';
import { resolveBotMemoryAgentId, resolveSubagentMemoryAccess } from '../memory/bot-memory-scope.js';
import {
  formatTouchedForPrivateChat,
  privateFactsVisibleInRoomTurn,
  queryTouchedForPrivateChat
} from '../rooms/touched-memory.js';
import { memoryBackendFromEnv, sessionScopeToAgent } from '../memory/memory-backend.js';
import { recallProgressive, recallProgressiveAsync, type RecallContext, type RecallDiagnostic } from '../memory/memory-recall.js';
import { resolveMemorySettings } from '../memory/memory-settings.js';
import { decodePtcStoredValue, encodePersistedPtcValue, isPtcAppendixEligible } from '../memory/ptc-meta.js';
import type { AgentMemoryStore } from '../memory/store.js';
import type { AgentMemory } from '../memory/types.js';
import type { SessionMessage, SessionRecord } from '../types.js';
import { applyJevMemorySelect } from '../jev/apply.js';
import { workingLogPath } from './working-log.js';
import { runProfileFromSession } from '../runtime/run-profile.js';

export {
  compileContextPack,
  formatCompiledContextPack,
  MEMORY_CONTEXT_APPENDIX_PREFIX
};
export type { CompiledContextPack, RecallSources };

export function lastUserQueryFromMessages(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const texts = m.parts
      .filter((p): p is Extract<(typeof m.parts)[number], { type: 'text' }> => p.type === 'text')
      .map((p) => p.text.trim())
      .filter(Boolean)
      .filter((t) => !isMemoryContextAppendixText(t));
    if (texts.length > 0) return texts[texts.length - 1]!;
  }
  return '';
}

export interface CompileTurnAppendixInput {
  session: SessionRecord;
  query: string;
  store?: {
    agentMemory?(): AgentMemoryStore;
    setDaemonControl?(key: string, value: unknown): void;
    getDaemonControl?(key: string): unknown;
    listSessionMemory?(sessionId: string): Array<{
      id?: string;
      scope: string;
      key: string;
      value: string;
      metadata?: Record<string, unknown>;
      importance?: number;
      source?: string;
      updatedAt?: string;
    }>;
    getBot?(id: string): { id?: string; agentId: string } | undefined;
    listBots?(opts?: { includeHidden?: boolean }): Array<{ id: string; agentId: string }>;
    getSession?(id: string): SessionRecord | undefined;
    updateSession?(id: string, patch: Partial<SessionRecord>): SessionRecord;
  };
  stateDir?: string;
  sources?: RecallSources;
  embedQuery?: (text: string) => Promise<number[] | null>;
  onDiagnostic?: (diagnostic: RecallDiagnostic) => void;
}

function packFromSources(sources: RecallSources, query: string): CompiledContextPack {
  return compileContextPack(sources, query);
}

async function maybeFilterPackByJev(
  store: CompileTurnAppendixInput['store'],
  query: string,
  pack: CompiledContextPack
): Promise<CompiledContextPack> {
  if (!store || pack.sections.length < 2) return pack;
  const kept = await applyJevMemorySelect(
    store,
    query,
    pack.sections.map((s) => ({ id: s.id, text: s.text }))
  );
  if (!kept) return pack;
  const keep = new Set(kept);
  const sections = pack.sections.filter((s) => keep.has(s.id));
  if (sections.length === 0) return pack;
  const combined = sections.map((s) => s.text).filter(Boolean).join('\n\n');
  return {
    ...pack,
    sections,
    combined,
    combinedChars: combined.length
  };
}

/** session_memory rows shaped as recall rows, for the legacy `session` backend. */
function legacySessionRows(
  store: CompileTurnAppendixInput['store'],
  sessionId: string
): AgentMemory[] | undefined {
  if (memoryBackendFromEnv() !== 'session' || !store?.listSessionMemory) return undefined;
  const now = new Date().toISOString();
  const rows: AgentMemory[] = [];
  for (const entry of store.listSessionMemory(sessionId)) {
    if (!sharedMemoryVisible(store, entry, sessionId)) continue;
    if (entry.scope !== 'scratch' && entry.scope !== 'long') continue;
    const meta = entry.metadata ?? {};
    rows.push({
      id: entry.id ?? `legacy:${entry.scope}:${entry.key}`,
      scope: sessionScopeToAgent(entry.scope),
      namespace: typeof meta.namespace === 'string' ? meta.namespace : 'default',
      key: entry.key,
      value: encodePersistedPtcValue(entry.value, meta),
      sessionId,
      importance: entry.importance ?? 0.5,
      source: typeof meta.source === 'string' ? meta.source : entry.source,
      confidence: 'medium',
      accessCount: 0,
      createdAt: entry.updatedAt ?? now,
      updatedAt: entry.updatedAt ?? now
    });
  }
  return rows;
}

function legacyRowsForSession(
  store: CompileTurnAppendixInput['store'],
  sessionIds: string[]
): AgentMemory[] | undefined {
  const rows: AgentMemory[] = [];
  let found = false;
  for (const sessionId of sessionIds) {
    const part = legacySessionRows(store, sessionId);
    if (!part) continue;
    found = true;
    rows.push(...part);
  }
  return found ? rows : undefined;
}

function recallInput(input: CompileTurnAppendixInput): RecallContext | RecallSources | null {
  if (runProfileFromSession(input.session).persistentMemory === 'off') return null;
  const settings = resolveMemorySettings(input.store);
  if (!settings.compilerEnabled) return null;

  if (input.sources) return input.sources;

  const am = input.store && typeof input.store.agentMemory === 'function' ? input.store.agentMemory() : undefined;
  if (!am) {
    const listed = (input.store?.listSessionMemory?.(input.session.id) ?? []).filter((m) => {
      if (!sharedMemoryVisible(input.store ?? {}, m, input.session.id)) return false;
      if (m.metadata?.source === 'dyn-tool' || m.metadata?.namespace === 'dyn-tools') {
        return m.metadata?.pin === true;
      }
      return isPtcAppendixEligible(m);
    });
    const working =
      listed.length === 0
        ? ''
        : [
            '## 相关工作记忆',
            '',
            ...listed
              .slice(0, 20)
              .map((m) => `- ${m.key}: ${decodePtcStoredValue(String(m.value ?? '')).value}`)
          ].join('\n');
    return { userProfile: '', core: '', working, workingFile: '' };
  }

  const identityStore = input.store as SqliteStateStore;
  const principal = resolveBotMemoryAgentId(input.session, input.store) && typeof input.store?.setDaemonControl === 'function' ? principalFromSession(identityStore, input.session) : undefined;
  const userId = principal?.userId ?? (
    typeof input.session.metadata?.userId === 'string'
      ? input.session.metadata.userId
      : process.env.RAW_AGENT_DEFAULT_USER_ID?.trim() || undefined);
  const tenantId =
    typeof input.session.metadata?.tenantId === 'string'
      ? input.session.metadata.tenantId
      : process.env.RAW_AGENT_DEFAULT_TENANT_ID?.trim() || undefined;

  const parentSessionId = resolveSubagentMemoryAccess(input.session, input.store)?.parentSessionId;
  const sessionIds = parentSessionId ? [input.session.id, parentSessionId] : [input.session.id];
  return {
    // Filter the raw persisted rows before recall ranking, excerpts or embeddings
    // can reuse facts derived from a group whose access has since been revoked.
    store: new Proxy(am, {
      get(target, property) {
        if (property === 'search') return (filter: Parameters<AgentMemoryStore['search']>[0]) =>
          target.search(filter).filter(row => sharedMemoryVisible(input.store ?? {}, row,
            filter.scope?.startsWith('session.') ? filter.sessionId : undefined));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }),
    query: input.query,
    userId,
    tenantId,
    sessionId: input.session.id,
    sessionRows: legacyRowsForSession(input.store, sessionIds),
    alsoSessionIds: parentSessionId ? [parentSessionId] : undefined,
    agentId: resolveBotMemoryAgentId(input.session, input.store),
    workingLogPath: input.stateDir && !hasRevokedSharedContext(input.store ?? {}, input.session.id)
      ? workingLogPath(input.stateDir, input.session.id) : undefined,
    stateDir: input.stateDir,
    embeddings: (id) => am.getEmbedding(id)
  };
}

function buildSources(input: CompileTurnAppendixInput): RecallSources | null {
  const source = recallInput(input);
  return source && 'store' in source ? recallProgressive(source) : source;
}

function roomIdOf(session: CompileTurnAppendixInput['session']): string {
  const roomId = session.metadata?.roomId;
  return typeof roomId === 'string' ? roomId.trim() : '';
}

function botIdOf(session: CompileTurnAppendixInput['session']): string {
  const botId = session.metadata?.botId;
  return typeof botId === 'string' ? botId.trim() : '';
}

function touchDatabase(store: CompileTurnAppendixInput['store']): Parameters<typeof queryTouchedForPrivateChat>[0] | undefined {
  const db = (store as { db?: { exec?: unknown; prepare?: unknown } } | undefined)?.db;
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') return undefined;
  return db as Parameters<typeof queryTouchedForPrivateChat>[0];
}

function isRoomMemoryTurn(input: CompileTurnAppendixInput): boolean {
  if (roomIdOf(input.session)) return true;
  const namespaced = resolveBotMemoryAgentId(input.session, input.store);
  return typeof namespaced === 'string' && namespaced.startsWith('room:');
}

/** Fact text only. The private transcript stays out of the room turn. */
function roomPrivateFactAppendix(input: CompileTurnAppendixInput): string {
  const memory = input.store?.agentMemory?.();
  if (!memory || !isRoomMemoryTurn(input)) return '';
  const facts = privateFactsVisibleInRoomTurn(memory, input.session, input.store);
  if (!facts.length) return '';
  return ['Private facts this bot remembers. Not a copy of the private transcript.', ...facts.map(fact => `- ${fact}`)].join('\n');
}

/** Private chats only. A room turn already received its own push. */
function touchedPrivateChatAppendix(input: CompileTurnAppendixInput): string {
  if (roomIdOf(input.session) || isRoomMemoryTurn(input)) return '';
  const botId = botIdOf(input.session);
  const db = touchDatabase(input.store);
  if (!botId || !db) return '';
  return formatTouchedForPrivateChat(queryTouchedForPrivateChat(db, { botId }));
}

function turnMemoryExtras(input: CompileTurnAppendixInput): string {
  try {
    return [roomPrivateFactAppendix(input), touchedPrivateChatAppendix(input)].filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

function joinAppendix(base: string, extra: string): string {
  if (!extra) return base;
  if (!base) return extra;
  return `${base}\n\n${extra}`;
}

export function compileTurnAppendix(input: CompileTurnAppendixInput): string {
  let base = '';
  try {
    const sources = buildSources(input);
    base = !sources ? '' : formatCompiledContextPack(packFromSources(sources, input.query));
  } catch {
    base = '';
  }
  return joinAppendix(base, turnMemoryExtras(input));
}

/** Shared real-turn and preview pipeline: identity, settings, embeddings, logs and Jev. */
export async function previewContextPackAsync(input: CompileTurnAppendixInput): Promise<CompiledContextPack & { diagnostics: RecallDiagnostic[] }> {
  const diagnostics: RecallDiagnostic[] = [];
  const onDiagnostic = (diagnostic: RecallDiagnostic) => {
    diagnostics.push(diagnostic);
    try { input.onDiagnostic?.(diagnostic); } catch { /* observers cannot interrupt recall */ }
  };
  let pack = compileContextPack({ userProfile: '', core: '', working: '', workingFile: '' }, input.query);
  try {
    const source = recallInput(input);
    if (source) {
      const sources = 'store' in source
        ? await recallProgressiveAsync({ ...source, settings: resolveMemorySettings(input.store), embedQuery: input.embedQuery, onDiagnostic })
        : source;
      pack = await maybeFilterPackByJev(input.store, input.query, packFromSources(sources, input.query));
    }
  } catch {
    onDiagnostic({ code: 'recall_unavailable', mode: 'empty', reason: 'Memory recall unavailable; continuing without a memory appendix.' });
  }
  return { ...pack, diagnostics };
}

export async function compileTurnAppendixAsync(input: CompileTurnAppendixInput): Promise<string> {
  const pack = await previewContextPackAsync(input);
  // Store only bounded, sanitized diagnostics; never persist upstream errors or credentials.
  const current = input.store?.getSession?.(input.session.id)?.metadata ?? input.session.metadata;
  if (pack.diagnostics.length || current.memoryRecallDiagnostics) {
    const metadata = { ...current, memoryRecallDiagnostics: pack.diagnostics };
    input.session.metadata = metadata;
    if (JSON.stringify(current.memoryRecallDiagnostics) !== JSON.stringify(pack.diagnostics)) {
      try { input.store?.updateSession?.(input.session.id, { metadata }); } catch { /* best-effort observation */ }
    }
  }
  return joinAppendix(formatCompiledContextPack(pack), turnMemoryExtras(input));
}

/** Legacy synchronous API uses the same identity/settings inputs, without network retrieval. */
export function previewContextPack(input: CompileTurnAppendixInput): CompiledContextPack {
  return compileContextPack(buildSources(input) ?? { userProfile: '', core: '', working: '', workingFile: '' }, input.query);
}

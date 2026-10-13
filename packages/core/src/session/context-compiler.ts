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
import { resolveBotMemoryAgentId } from '../memory/bot-memory-scope.js';
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

function recallInput(input: CompileTurnAppendixInput): RecallContext | RecallSources | null {
  if (runProfileFromSession(input.session).persistentMemory === 'off') return null;
  const settings = resolveMemorySettings(input.store);
  if (!settings.compilerEnabled) return null;

  if (input.sources) return input.sources;

  const am = input.store && typeof input.store.agentMemory === 'function' ? input.store.agentMemory() : undefined;
  if (!am) {
    const listed = (input.store?.listSessionMemory?.(input.session.id) ?? []).filter((m) => {
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

  const userId =
    typeof input.session.metadata?.userId === 'string'
      ? input.session.metadata.userId
      : process.env.RAW_AGENT_DEFAULT_USER_ID?.trim() || undefined;
  const tenantId =
    typeof input.session.metadata?.tenantId === 'string'
      ? input.session.metadata.tenantId
      : process.env.RAW_AGENT_DEFAULT_TENANT_ID?.trim() || undefined;

  return {
    store: am,
    query: input.query,
    userId,
    tenantId,
    sessionId: input.session.id,
    sessionRows: legacySessionRows(input.store, input.session.id),
    agentId: resolveBotMemoryAgentId(input.session, input.store),
    workingLogPath: input.stateDir ? workingLogPath(input.stateDir, input.session.id) : undefined,
    stateDir: input.stateDir,
    embeddings: (id) => am.getEmbedding(id)
  };
}

function buildSources(input: CompileTurnAppendixInput): RecallSources | null {
  const source = recallInput(input);
  return source && 'store' in source ? recallProgressive(source) : source;
}

export function compileTurnAppendix(input: CompileTurnAppendixInput): string {
  try {
    const sources = buildSources(input);
    if (!sources) return '';
    return formatCompiledContextPack(packFromSources(sources, input.query));
  } catch {
    return '';
  }
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
  if (!pack.diagnostics.length && !current.memoryRecallDiagnostics) return formatCompiledContextPack(pack);
  const metadata = { ...current, memoryRecallDiagnostics: pack.diagnostics };
  input.session.metadata = metadata;
  if (JSON.stringify(current.memoryRecallDiagnostics) !== JSON.stringify(pack.diagnostics)) {
    try { input.store?.updateSession?.(input.session.id, { metadata }); } catch { /* best-effort observation */ }
  }
  return formatCompiledContextPack(pack);
}

/** Legacy synchronous API uses the same identity/settings inputs, without network retrieval. */
export function previewContextPack(input: CompileTurnAppendixInput): CompiledContextPack {
  return compileContextPack(buildSources(input) ?? { userProfile: '', core: '', working: '', workingFile: '' }, input.query);
}

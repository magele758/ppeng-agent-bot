import type { SqliteStateStore } from '../storage.js';
import type { SessionMessage } from '../types.js';
import type { RoutineRun } from './routine-runtime.js';

/** A run owns its sequence range, not every later reply in the shared chat. */
export function routineExecutionMessages(store: SqliteStateStore, run: RoutineRun): SessionMessage[] {
  if (!run.sessionId) return [];
  const all = store.listMessages(run.sessionId).filter(message => withinFinishedRun(message, run));
  if (run.messageSourceId) {
    const owned = new Set(store.messageIdsForSource(run.sessionId,run.messageSourceId));
    return all.filter(message=>owned.has(message.id));
  }
  const prompt = all.find(m => m.role === 'user' && m.key === (run.steerKey ?? `routine:${run.id}`));
  const start = run.startSeq ?? prompt?.seq;
  const candidates = all.filter(m => start !== undefined ? (m.seq ?? 0) > start : Date.parse(m.createdAt) >= Date.parse(run.startedAt ?? run.createdAt));
  const boundary = candidates.find(m => m.role === 'user');
  return boundary ? candidates.filter(m => (m.seq ?? 0) < (boundary.seq ?? 0)) : candidates;
}

function withinFinishedRun(message: SessionMessage, run: RoutineRun): boolean {
  if (!run.finishedAt) return true;
  return Date.parse(message.createdAt) <= Date.parse(run.finishedAt);
}

export function routineAnswerMessages(store: SqliteStateStore, run: RoutineRun): SessionMessage[] {
  if (!run.sessionId) return [];
  const owned = new Set(routineExecutionMessages(store, run).map(m => m.id));
  return store.foldMessages(run.sessionId).filter(m => owned.has(m.id) && m.role === 'assistant'
    && m.key !== 'compact-summary' && !/^(?:routine-result:|session-recap:|recap:)/.test(m.key ?? '')
    && m.parts.some(p => p.type === 'text' && p.text.trim() && !p.text.trim().startsWith('[routine:')));
}

export function routineSourceRefusal(store: SqliteStateStore, run: RoutineRun): string | undefined {
  for (const message of routineExecutionMessages(store, run)) {
    for (const part of message.parts) {
      if (part.type !== 'tool_result' || part.ok !== false) continue;
      try {
        const value = JSON.parse(part.content);
        if (value?.error === 'source_scope_denied') return `source_scope_denied: ${part.name}; configure the saved source scope or approve this exact operation`;
      } catch { /* Ordinary tool text is not a structured authorization refusal. */ }
    }
  }
  return undefined;
}

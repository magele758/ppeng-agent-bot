/**
 * Next-input suggestion for a bot composer.
 * GET/PATCH /api/input-suggestion/settings persists in daemon_control.
 * POST /api/sessions/:id/input-suggestion reuses a persisted per-reply result.
 */

import type { RawAgentRuntime, SessionMessage } from '@ppeng/agent-core';
import {
  NotFoundError,
  ValidationError,
  hasPersistedInputSuggestionSettings,
  inputSuggestionRequest,
  parseInputSuggestion,
  readInputSuggestionSettings,
  recentSuggestionTurns,
  writeInputSuggestionSettings,
  type InputSuggestionSettingsPatch
} from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

function isBotChat(session: { mode?: string; metadata?: Record<string, unknown> | null }): boolean {
  return session.mode === 'chat' && session.metadata?.canonicalBotChat === true;
}

type Suggestion = ReturnType<typeof parseInputSuggestion>;
interface SavedSuggestion {
  sessionId: string;
  replyId: string;
  state: 'pending' | 'done';
  suggestion: Suggestion;
}
interface SuggestionFlight {
  runtime: RawAgentRuntime;
  replyId: string;
  controller: AbortController;
  result: Promise<Suggestion>;
}
const suggestionRequests = new Map<string, Set<SuggestionFlight>>();
const CACHE_KEY = 'inputSuggestionCache';

export function cancelInputSuggestion(sessionId: string): void {
  for (const flight of suggestionRequests.get(sessionId) ?? []) flight.controller.abort();
}

function completedReply(runtime: RawAgentRuntime, sessionId: string) {
  const session = runtime.getSession(sessionId);
  if (!session || session.status !== 'idle') return null;
  const messages = (runtime.store.foldMessages(sessionId) as SessionMessage[])
    .filter(message => !message.hidden && (message.role === 'user' || message.role === 'assistant')
      && message.parts.some(part => part.type === 'text' && part.text.trim()));
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return null;
  return { replyId: last.id, turns: recentSuggestionTurns(messages) };
}

function savedSuggestion(runtime: RawAgentRuntime, sessionId: string): SavedSuggestion | undefined {
  return runtime.getSession(sessionId)?.metadata?.[CACHE_KEY] as SavedSuggestion | undefined;
}

async function suggestionForReply(runtime: RawAgentRuntime, sessionId: string): Promise<Suggestion> {
  const reply = completedReply(runtime, sessionId);
  const complete = runtime.modelAdapter.completeText;
  if (!reply || !complete) return null;
  const existingFlight = [...(suggestionRequests.get(sessionId) ?? [])]
    .find(flight => flight.runtime === runtime && flight.replyId === reply.replyId);
  if (existingFlight) return existingFlight.result;
  // Claim before calling the model. A restarted daemon keeps an interrupted claim
  // as an empty result rather than silently issuing a second request for this reply.
  const claimed = runtime.store.transaction(() => {
    const saved = savedSuggestion(runtime, sessionId);
    if (saved?.sessionId === sessionId && saved.replyId === reply.replyId) return false;
    const session = runtime.getSession(sessionId)!;
    runtime.store.updateSession(sessionId, { metadata: { ...session.metadata, [CACHE_KEY]: {
      sessionId, replyId: reply.replyId, state: 'pending', suggestion: null
    } satisfies SavedSuggestion } });
    return true;
  });
  if (!claimed) return savedSuggestion(runtime, sessionId)?.suggestion ?? null;
  cancelInputSuggestion(sessionId);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
  const flight: SuggestionFlight = { runtime, replyId: reply.replyId, controller, result: Promise.resolve(null) };
  const flights = suggestionRequests.get(sessionId) ?? new Set<SuggestionFlight>();
  flights.add(flight);
  suggestionRequests.set(sessionId, flights);
  flight.result = (async () => {
    let suggestion: Suggestion = null;
    let onAbort = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('suggestion cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const text = await Promise.race([complete.call(runtime.modelAdapter, {
        ...inputSuggestionRequest(reply.turns), jsonMode: true, signal
      }), cancelled]);
      if (!signal.aborted) suggestion = parseInputSuggestion(text);
    } catch { /* An unsuccessful attempt is also cached for this reply. */ }
    finally { signal.removeEventListener('abort', onAbort); }
    const current = completedReply(runtime, sessionId);
    if (signal.aborted || current?.replyId !== reply.replyId || !readInputSuggestionSettings(runtime.store).enabled) suggestion = null;
    runtime.store.transaction(() => {
      const session = runtime.getSession(sessionId);
      const saved = savedSuggestion(runtime, sessionId);
      if (session && saved?.replyId === reply.replyId && saved.sessionId === sessionId) {
        runtime.store.updateSession(sessionId, { metadata: { ...session.metadata, [CACHE_KEY]: {
          sessionId, replyId: reply.replyId, state: 'done', suggestion
        } satisfies SavedSuggestion } });
      }
    });
    return suggestion;
  })().finally(() => {
    flights.delete(flight);
    if (!flights.size && suggestionRequests.get(sessionId) === flights) suggestionRequests.delete(sessionId);
  });
  return flight.result;
}

function effective(runtime: RawAgentRuntime) {
  const settings = readInputSuggestionSettings(runtime.store);
  return {
    settings,
    effective: {
      enabled: settings.enabled,
      source: hasPersistedInputSuggestionSettings(runtime.store) ? 'ui' : 'default'
    }
  };
}

export function inputSuggestionRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/input-suggestion/settings',
      handler: ({ response }) => {
        json(response, 200, effective(runtime));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/input-suggestion/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as InputSuggestionSettingsPatch & Record<string, unknown>;
        const patch: InputSuggestionSettingsPatch = {};
        if (body && 'enabled' in body) {
          if (typeof body.enabled !== 'boolean') {
            throw new ValidationError('enabled must be a boolean');
          }
          patch.enabled = body.enabled;
        }
        writeInputSuggestionSettings(runtime.store, patch);
        json(response, 200, effective(runtime));
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/input-suggestion',
      handler: async ({ requireParam, readBody, response }) => {
        const sessionId = requireParam('id');
        const session = runtime.getSession(sessionId);
        if (!session) throw new NotFoundError(`session ${sessionId} not found`);
        const settings = readInputSuggestionSettings(runtime.store);
        if (!settings.enabled || !isBotChat(session)) {
          json(response, 200, { suggestion: null, enabled: settings.enabled });
          return;
        }
        const body = (await readBody().catch(() => ({}))) as { requestId?: unknown };
        const requestId = typeof body?.requestId === 'number' ? body.requestId : undefined;
        const suggestion = await suggestionForReply(runtime, sessionId);
        json(response, 200, { suggestion, enabled: true, requestId });
      }
    }
  ];
}

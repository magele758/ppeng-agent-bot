/**
 * Next-input suggestion for a bot composer.
 * GET/PATCH /api/input-suggestion/settings persists in daemon_control.
 * POST /api/sessions/:id/input-suggestion asks the model once, quietly.
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

interface SuggestionFlight {
  current: number;
  controller: AbortController | null;
}

const suggestionRequests = new Map<string, SuggestionFlight>();

/** Drop an in-flight guess for a session that is gone. Safe when none is running. */
export function cancelInputSuggestion(sessionId: string): void {
  const slot = suggestionRequests.get(sessionId);
  if (!slot) return;
  slot.controller?.abort();
  suggestionRequests.delete(sessionId);
}

function beginSuggestionFlight(sessionId: string, requestId: number | undefined): {
  slot: SuggestionFlight;
  controller: AbortController;
  signal: AbortSignal;
} {
  let slot = suggestionRequests.get(sessionId);
  if (!slot) {
    slot = { current: 0, controller: null };
    suggestionRequests.set(sessionId, slot);
  }
  slot.controller?.abort();
  if (requestId !== undefined) slot.current = Math.max(slot.current, requestId);
  const controller = new AbortController();
  slot.controller = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
  return { slot, controller, signal };
}

function endSuggestionFlight(sessionId: string, controller: AbortController): void {
  const slot = suggestionRequests.get(sessionId);
  if (slot?.controller === controller) suggestionRequests.delete(sessionId);
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
        const complete = runtime.modelAdapter.completeText;
        if (!complete) {
          json(response, 200, { suggestion: null, enabled: true, requestId });
          return;
        }
        const turns = recentSuggestionTurns(runtime.store.foldMessages(sessionId) as SessionMessage[]);
        if (turns.length === 0 || turns.at(-1)?.role !== 'assistant') {
          json(response, 200, { suggestion: null, enabled: true, requestId });
          return;
        }
        const prompt = inputSuggestionRequest(turns);
        const { slot, controller, signal } = beginSuggestionFlight(sessionId, requestId);
        let suggestion = null;
        try {
          const text = await complete({ ...prompt, jsonMode: true, signal });
          if (!signal.aborted) suggestion = parseInputSuggestion(text);
        } catch {
          suggestion = null;
        } finally {
          endSuggestionFlight(sessionId, controller);
        }
        if (requestId !== undefined && slot.current !== requestId) suggestion = null;
        if (signal.aborted) suggestion = null;
        json(response, 200, { suggestion, enabled: true, requestId });
      }
    }
  ];
}

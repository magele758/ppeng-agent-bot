/**
 * GET/PATCH /api/session-recap/settings — automatic away recap.
 * POST /api/sessions/:id/recap — one line from the model about the latest turns.
 * An empty or failed completion is not cached.
 */

import { NotFoundError, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';
import {
  hasPersistedSessionRecapSettings,
  readSessionRecapSettings,
  recapFeatureEnabled,
  writeSessionRecapSettings,
  type SessionRecapSettingsPatch
} from '../session-recap-settings.js';
import {
  SESSION_RECAP_CACHE_KEY,
  composeSessionRecap,
  readSessionRecapCache,
  recapAnchorId,
  recapLocale,
  resolveConversationTimezone,
  type RecapLocale
} from '../session-recap-text.js';

const RECAP_WAIT_MS = 20_000;
const recapFlights = new Map<string, Promise<{ text: string | null; anchorId: string | null; hint: string }>>();

function payload(runtime: RawAgentRuntime) {
  const settings = readSessionRecapSettings(runtime.store);
  return {
    settings,
    effective: {
      active: settings.active,
      enabled: settings.enabled,
      source: hasPersistedSessionRecapSettings(runtime.store) ? 'ui' : 'default'
    }
  };
}

export function sessionRecapRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  return [
    {
      method: 'GET',
      pattern: '/api/session-recap/settings',
      handler: ({ response }) => {
        json(response, 200, payload(runtime));
      }
    },
    {
      method: 'PATCH',
      pattern: '/api/session-recap/settings',
      handler: async ({ readBody, response }) => {
        const body = (await readBody()) as SessionRecapSettingsPatch & Record<string, unknown>;
        const patch: SessionRecapSettingsPatch = {};
        if (body && typeof body === 'object' && 'active' in body) {
          if (typeof body.active !== 'boolean') throw new ValidationError('active must be a boolean');
          patch.active = body.active;
        }
        if (body && typeof body === 'object' && 'enabled' in body) {
          if (typeof body.enabled !== 'boolean') throw new ValidationError('enabled must be a boolean');
          patch.enabled = body.enabled;
        }
        writeSessionRecapSettings(runtime.store, patch);
        json(response, 200, payload(runtime));
      }
    },
    {
      method: 'POST',
      pattern: '/api/sessions/:id/recap',
      handler: async ({ requireParam, readBody, response }) => {
        if (!recapFeatureEnabled(readSessionRecapSettings(runtime.store))) {
          json(response, 200, { text: null, anchorId: null, hint: '' });
          return;
        }
        const sessionId = requireParam('id');
        const session = runtime.getSession(sessionId);
        if (!session) throw new NotFoundError('session', sessionId);
        const body = (await readBody().catch(() => ({}))) as { locale?: unknown };
        const locale = recapLocale(body?.locale);
        if (!locale) throw new ValidationError('locale must be zh or en');
        json(response, 200, await recapForSession(runtime, sessionId, locale));
      }
    }
  ];
}

async function recapForSession(
  runtime: RawAgentRuntime,
  sessionId: string,
  locale: RecapLocale
): Promise<{ text: string | null; anchorId: string | null; hint: string }> {
  const messages = runtime.store.foldMessages(sessionId);
  const anchorId = recapAnchorId(messages);
  if (!anchorId) return { text: null, anchorId: null, hint: '' };
  const key = `${sessionId}\0${anchorId}\0${locale}`;
  const existing = recapFlights.get(key);
  if (existing) return existing;
  const pending = composeAndStore(runtime, sessionId, locale, messages).finally(() => {
    if (recapFlights.get(key) === pending) recapFlights.delete(key);
  });
  recapFlights.set(key, pending);
  return pending;
}

async function composeAndStore(
  runtime: RawAgentRuntime,
  sessionId: string,
  locale: RecapLocale,
  messages: ReturnType<RawAgentRuntime['store']['foldMessages']>
): Promise<{ text: string | null; anchorId: string | null; hint: string }> {
  const complete = runtime.modelAdapter.completeText;
  const session = runtime.getSession(sessionId);
  const cached = readSessionRecapCache(session?.metadata);
  if (!complete) return { text: null, anchorId: recapAnchorId(messages), hint: '' };
  const result = await composeSessionRecap({
    messages,
    locale,
    cached,
    clock: { nowMs: Date.now(), timezone: resolveConversationTimezone(session?.metadata) },
    signal: AbortSignal.timeout(RECAP_WAIT_MS),
    completeText: (request) => complete.call(runtime.modelAdapter, request)
  });
  if (result.cache) {
    runtime.store.transaction(() => {
      const current = runtime.getSession(sessionId);
      if (!current) return;
      if (recapAnchorId(runtime.store.foldMessages(sessionId)) !== result.anchorId) return;
      runtime.store.updateSession(sessionId, {
        metadata: { ...current.metadata, [SESSION_RECAP_CACHE_KEY]: result.cache }
      });
    });
  }
  return { text: result.text, anchorId: result.anchorId, hint: result.hint };
}

/**
 * Model registry routing: fallback across configured providers + thinking_mode.
 * Does not replace heuristic — it is always the last candidate.
 */

import type { ModelAdapter, SessionRecord } from '../types.js';
import { failClosedRoleAdapter, resolvePinnedRoleAdapter } from './role-pinning.js';
import {
  HEURISTIC_PROVIDER_ID,
  createAdapterFromProvider,
  findProvider,
  heuristicProvider,
  readModelCatalog,
  resolveSessionPreferredRef,
  type CatalogModel,
  type ModelProviderCatalog,
  type ModelProvidersStore,
  type ModelRef
} from './provider-catalog.js';

export type ModelCapability = 'thinking' | 'vision' | 'tools' | 'text';
export type ThinkingMode = 'on' | 'off' | 'auto';

export interface RouteDecision {
  type: 'preferred' | 'thinking_mode' | 'fallback' | 'heuristic';
  message: string;
  data?: Record<string, unknown>;
}

export interface ModelRouteResult {
  primary: ModelAdapter;
  /** Catalog ref the primary adapter was actually built from; absent when it is the runtime/env fallback adapter. */
  primaryRef?: ModelRef;
  candidates: ModelAdapter[];
  decisions: RouteDecision[];
  thinkingMode: ThinkingMode;
  /** Set when an explicit handoff role could not be pinned. Candidates are not catalog fallbacks. */
  rolePinFailed?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 422]);
const RETRYABLE_MESSAGE =
  /rate.?limit|quota|overloaded|too many requests|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway ?time-?out|connection error|fetch failed|socket hang up|timeout|timed out|ECONN(?:RESET|ABORTED|REFUSED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|invalid model|model not found|unknown model/i;

export function parseThinkingMode(raw: unknown): ThinkingMode | undefined {
  if (raw === 'on' || raw === 'off' || raw === 'auto') return raw;
  return undefined;
}

export function extractStatusCode(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const value = cur as Record<string, unknown>;
    const raw = value.statusCode ?? value.status ?? (value.response as { status?: number } | undefined)?.status;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 100 && n < 600) return n;
    cur = value.cause;
  }
  return undefined;
}

export function shouldFallbackProviderError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = extractStatusCode(err);
  if (status != null) {
    if (NON_RETRYABLE_STATUS.has(status) && status !== 404) return status === 404;
    if (RETRYABLE_STATUS.has(status)) return true;
    if (status === 404) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_MESSAGE.test(message);
}

function modelCaps(model: CatalogModel | undefined): string[] {
  return Array.isArray(model?.capabilities) ? model!.capabilities.map(String) : [];
}

function matchesThinking(model: CatalogModel | undefined, mode: ThinkingMode): boolean {
  if (mode === 'auto') return true;
  const caps = modelCaps(model);
  const thinking = caps.includes('thinking');
  if (mode === 'off') return !thinking;
  return thinking || caps.length === 0;
}

function sessionThinkingMode(session: SessionRecord | undefined, catalog: ModelProviderCatalog): ThinkingMode {
  return parseThinkingMode(session?.metadata?.thinkingMode) ?? catalog.thinkingMode ?? 'auto';
}

export function resolveRouteCandidates(input: {
  catalog: ModelProviderCatalog;
  session?: SessionRecord;
  env?: NodeJS.ProcessEnv;
  fallbackAdapter?: ModelAdapter;
}): {
  refs: ModelRef[];
  thinkingMode: ThinkingMode;
  decisions: RouteDecision[];
} {
  const catalog = input.catalog;
  const thinkingMode = sessionThinkingMode(input.session, catalog);
  const decisions: RouteDecision[] = [];
  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  const push = (ref: ModelRef, why: RouteDecision['type'], message: string) => {
    const key = `${ref.providerId}:${ref.modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
    decisions.push({ type: why, message, data: { ...ref } });
  };

  const sessionPick = resolveSessionPreferredRef(catalog, input.session, input.env);
  const preferred = sessionPick.ref;
  if (sessionPick.overrideSkipped) {
    const label =
      typeof sessionPick.overrideSkipped === 'string'
        ? sessionPick.overrideSkipped
        : `${sessionPick.overrideSkipped.providerId}/${sessionPick.overrideSkipped.modelId}`;
    decisions.push({
      type: 'fallback',
      message: `modelOverride ${label} not configured; using global default`,
      data: { modelOverride: sessionPick.overrideSkipped }
    });
  }
  if (preferred) {
    const provider = catalog.providers.find((p) => p.id === preferred.providerId);
    const model = provider?.models.find((m) => m.id === preferred.modelId);
    if (!provider || sessionPick.source === 'override' || matchesThinking(model, thinkingMode)) {
      push(
        preferred,
        'preferred',
        `${sessionPick.source} ref ${preferred.providerId}/${preferred.modelId}`
      );
    } else {
      decisions.push({
        type: 'thinking_mode',
        message: `preferred model skipped for thinkingMode=${thinkingMode}`,
        data: { ...preferred, thinkingMode }
      });
    }
  }

  for (const ref of catalog.fallbackRefs ?? []) {
    const provider = catalog.providers.find((p) => p.id === ref.providerId);
    const model = provider?.models.find((m) => m.id === ref.modelId);
    if (model && !matchesThinking(model, thinkingMode)) {
      decisions.push({
        type: 'thinking_mode',
        message: `fallback skipped for thinkingMode=${thinkingMode}`,
        data: { ...ref, thinkingMode }
      });
      continue;
    }
    push(ref, 'fallback', `catalog fallback ${ref.providerId}/${ref.modelId}`);
  }

  for (const provider of catalog.providers) {
    if (provider.kind === 'heuristic') continue;
    const pick = provider.models.find((m) => m.enabled !== false && matchesThinking(m, thinkingMode));
    if (pick) push({ providerId: provider.id, modelId: pick.id }, 'fallback', `provider ${provider.id}`);
  }

  push({ providerId: HEURISTIC_PROVIDER_ID, modelId: 'heuristic' }, 'heuristic', 'heuristic last resort');
  if (thinkingMode !== 'auto') {
    decisions.push({ type: 'thinking_mode', message: `thinkingMode=${thinkingMode}`, data: { thinkingMode } });
  }
  return { refs, thinkingMode, decisions };
}

/** Env/runtime fallback must not replace an explicit heuristic pick. */
function heuristicAdapter(fallback?: ModelAdapter): ModelAdapter {
  if (fallback?.name === 'heuristic') return fallback;
  return createAdapterFromProvider(heuristicProvider(), 'heuristic');
}

/**
 * Implicit last-resort heuristic (empty Lab catalog) must keep the runtime
 * adapter — tests inject MockLLM / scripted adapters this way. An explicit
 * Lab pick of heuristic still wins over env/runtime fallback.
 */
function adapterForHeuristicRef(
  fallback: ModelAdapter | undefined,
  explicitHeuristic: boolean,
  alreadyHasCandidate: boolean
): ModelAdapter {
  if (explicitHeuristic || alreadyHasCandidate) {
    return heuristicAdapter(fallback);
  }
  return fallback ?? heuristicAdapter();
}

export function resolveModelRoute(input: {
  store: ModelProvidersStore;
  session?: SessionRecord;
  env?: NodeJS.ProcessEnv;
  fallbackAdapter?: ModelAdapter;
}): ModelRouteResult {
  const catalog = readModelCatalog(input.store);
  const env = input.env ?? process.env;
  const pinned = resolvePinnedRoleAdapter({ session: input.session, catalog, env });
  if (pinned.handled) {
    const thinkingMode = sessionThinkingMode(input.session, catalog);
    if (pinned.rolePinFailed || !pinned.adapter) {
      const adapter = failClosedRoleAdapter(pinned.reason);
      return {
        primary: adapter,
        candidates: [adapter],
        decisions: [{ type: 'fallback', message: pinned.reason, data: { failClosed: true, rolePinFailed: true } }],
        thinkingMode,
        rolePinFailed: true,
      };
    }
    return {
      primary: pinned.adapter,
      candidates: [pinned.adapter],
      decisions: [{ type: 'preferred', message: pinned.reason, data: { rolePinned: true } }],
      thinkingMode,
    };
  }
  const { refs, thinkingMode, decisions } = resolveRouteCandidates({
    catalog,
    session: input.session,
    env,
    fallbackAdapter: input.fallbackAdapter
  });
  const explicitHeuristic = resolveSessionPreferredRef(catalog, input.session, env).ref?.providerId === HEURISTIC_PROVIDER_ID;
  const adapters: ModelAdapter[] = [];
  const adapterRefs: ModelRef[] = [];
  for (const ref of refs) {
    if (ref.providerId === HEURISTIC_PROVIDER_ID) {
      adapters.push(
        adapterForHeuristicRef(input.fallbackAdapter, explicitHeuristic, adapters.length > 0)
      );
      adapterRefs.push(ref);
      continue;
    }
    const provider = findProvider(catalog, ref.providerId, env);
    if (!provider) continue;
    if (provider.kind !== 'heuristic' && (!provider.apiKey.trim() || !provider.baseUrl.trim())) {
      continue;
    }
    adapters.push(createAdapterFromProvider(provider, ref.modelId));
    adapterRefs.push(ref);
  }
  if (adapters.length === 0) {
    adapters.push(input.fallbackAdapter ?? heuristicAdapter());
  }
  return {
    primary: adapters[0]!,
    ...(adapterRefs[0] ? { primaryRef: adapterRefs[0] } : {}),
    candidates: adapters,
    decisions,
    thinkingMode
  };
}

export async function withProviderFallback<T>(
  candidates: Array<{ adapter: ModelAdapter; label?: string }>,
  invoke: (adapter: ModelAdapter, index: number) => Promise<T>,
  options?: { shouldFallback?: (err: unknown) => boolean }
): Promise<T> {
  const shouldFallback = options?.shouldFallback ?? shouldFallbackProviderError;
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]!;
    try {
      return await invoke(item.adapter, i);
    } catch (err) {
      lastError = err;
      const can = i < candidates.length - 1 && shouldFallback(err);
      if (!can) throw err;
    }
  }
  throw lastError;
}

export type { CatalogModel };

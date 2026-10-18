/**
 * Global model fallback chain: when the primary model's upstream keeps failing
 * (after the regular in-adapter retries), finish the SAME turn on the next
 * configured model instead of failing the run.
 *
 * Persisted in daemon_control KV (Lab "模型备选" card). Empty chain = feature off:
 * the runtime then keeps the legacy implicit routing untouched.
 * The session's modelRef / modelOverride is never rewritten — the next turn
 * starts on the primary model again.
 */

import { ValidationError, errorMessage } from '../errors.js';
import { nowIso } from '../id.js';
import { createLogger } from '../logger.js';
import type { ModelAdapter, ModelTurnResult, SessionRecord } from '../types.js';
import {
  classifyModelError,
  isTerminalModelErrorCategory,
  isUpstreamRetryableCategory,
  type ModelErrorCategory
} from './error-class.js';
import {
  createAdapterFromProvider,
  findProvider,
  parseModelRef,
  pickerOptions,
  readModelCatalog,
  resolveSessionPreferredRef,
  type ModelPickerOption,
  type ModelProvidersStore,
  type ModelRef
} from './provider-catalog.js';

export const MODEL_FALLBACK_SETTINGS_KEY = 'model_fallback_settings';
export const MODEL_FALLBACK_MAX_CHAIN = 8;

const log = createLogger('model-fallback');

export interface ModelFallbackSettings {
  chain: ModelRef[];
  updatedAt: string;
}

export interface ModelFallbackSettingsPatch {
  chain?: ModelRef[];
}

export function defaultModelFallbackSettings(): ModelFallbackSettings {
  return { chain: [], updatedAt: nowIso() };
}

function refKey(ref: ModelRef): string {
  return `${ref.providerId}::${ref.modelId}`;
}

export function normalizeModelFallbackSettings(raw: unknown): ModelFallbackSettings {
  const base = defaultModelFallbackSettings();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<ModelFallbackSettings>;
  const chain: ModelRef[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.chain)) {
    for (const item of value.chain) {
      const ref = parseModelRef(item);
      if (!ref || seen.has(refKey(ref))) continue;
      seen.add(refKey(ref));
      chain.push(ref);
      if (chain.length >= MODEL_FALLBACK_MAX_CHAIN) break;
    }
  }
  return { chain, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : base.updatedAt };
}

let warnedCorruptSettings = false;

/** A corrupt KV value (e.g. hand-edited JSON) must never break a turn: degrade to "chain off". */
function readSavedSettings(store: ModelProvidersStore): { saved: unknown; corrupt: boolean } {
  try {
    return { saved: store.getDaemonControl<unknown>(MODEL_FALLBACK_SETTINGS_KEY), corrupt: false };
  } catch (err) {
    if (!warnedCorruptSettings) {
      warnedCorruptSettings = true;
      log.warn(
        `model fallback settings are unreadable (${errorMessage(err)}); treating the chain as empty until saved again`
      );
    }
    return { saved: undefined, corrupt: true };
  }
}

export function readModelFallbackSettings(store: ModelProvidersStore): ModelFallbackSettings {
  const { saved } = readSavedSettings(store);
  return saved ? normalizeModelFallbackSettings(saved) : defaultModelFallbackSettings();
}

export function hasPersistedModelFallbackSettings(store: ModelProvidersStore): boolean {
  const { saved, corrupt } = readSavedSettings(store);
  return corrupt || saved != null;
}

/** Strict validation for the settings API: every entry must be a configured, selectable model. */
export function validateModelFallbackChain(raw: unknown, options: ModelPickerOption[]): ModelRef[] {
  if (!Array.isArray(raw)) throw new ValidationError('chain must be an array of {providerId, modelId}');
  if (raw.length > MODEL_FALLBACK_MAX_CHAIN) {
    throw new ValidationError(`chain may contain at most ${MODEL_FALLBACK_MAX_CHAIN} models`);
  }
  const allowed = new Set(
    options
      .filter((o) => o.kind !== 'heuristic')
      .map((o) => refKey({ providerId: o.providerId, modelId: o.modelId }))
  );
  const heuristic = new Set(
    options
      .filter((o) => o.kind === 'heuristic')
      .map((o) => refKey({ providerId: o.providerId, modelId: o.modelId }))
  );
  const out: ModelRef[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const ref = parseModelRef(item);
    if (!ref) throw new ValidationError(`chain[${index}] requires providerId and modelId`);
    const key = refKey(ref);
    if (heuristic.has(key) || ref.providerId === 'heuristic') {
      throw new ValidationError(`chain[${index}] ${ref.providerId}/${ref.modelId} is a local heuristic model and cannot be a fallback`);
    }
    if (!allowed.has(key)) {
      throw new ValidationError(`chain[${index}] ${ref.providerId}/${ref.modelId} is not a configured model`);
    }
    if (seen.has(key)) {
      throw new ValidationError(`chain[${index}] ${ref.providerId}/${ref.modelId} is listed more than once`);
    }
    seen.add(key);
    out.push(ref);
  });
  return out;
}

export function writeModelFallbackSettings(
  store: ModelProvidersStore,
  patch: ModelFallbackSettingsPatch,
  env: NodeJS.ProcessEnv = process.env
): ModelFallbackSettings {
  const current = readModelFallbackSettings(store);
  const chain =
    patch.chain !== undefined
      ? validateModelFallbackChain(patch.chain, pickerOptions(readModelCatalog(store), env))
      : current.chain;
  const next: ModelFallbackSettings = { chain, updatedAt: nowIso() };
  store.setDaemonControl(MODEL_FALLBACK_SETTINGS_KEY, next);
  return next;
}

export type ModelFallbackEntryIssue = 'not_configured' | 'missing_credentials';

export interface ModelFallbackEntryStatus extends ModelRef {
  usable: boolean;
  issue?: ModelFallbackEntryIssue;
}

function entryIssue(
  store: ModelProvidersStore,
  options: ModelPickerOption[],
  ref: ModelRef,
  env: NodeJS.ProcessEnv
): ModelFallbackEntryIssue | undefined {
  const listed = options.some((o) => o.providerId === ref.providerId && o.modelId === ref.modelId);
  const provider = findProvider(readModelCatalog(store), ref.providerId, env);
  if (!listed || !provider || provider.kind === 'heuristic') return 'not_configured';
  if ((!provider.apiKey.trim() || !provider.baseUrl.trim())) {
    return 'missing_credentials';
  }
  return undefined;
}

export function modelFallbackPayload(store: ModelProvidersStore, env: NodeJS.ProcessEnv = process.env) {
  const settings = readModelFallbackSettings(store);
  const options = pickerOptions(readModelCatalog(store), env);
  const chainStatus: ModelFallbackEntryStatus[] = settings.chain.map((ref) => {
    const issue = entryIssue(store, options, ref, env);
    return { ...ref, usable: !issue, ...(issue ? { issue } : {}) };
  });
  return {
    settings,
    options,
    chainStatus,
    effective: {
      enabled: chainStatus.some((c) => c.usable),
      source: hasPersistedModelFallbackSettings(store) ? ('ui' as const) : ('default' as const)
    }
  };
}

export interface FallbackCandidate {
  adapter: ModelAdapter;
  ref?: ModelRef;
  label: string;
}

export interface FallbackPlan {
  candidates: FallbackCandidate[];
}

const warnedGlobal = new Set<string>();

/**
 * Build [primary, ...chain] for a turn, or `undefined` when the feature is off
 * (empty chain, or no chain entry is currently usable) so the caller keeps the
 * legacy routing byte-for-byte.
 */
export function planModelFallback(input: {
  store: ModelProvidersStore;
  session?: SessionRecord;
  /** The adapter this turn would use without a chain (keeps VL wrapping etc.). */
  primary: ModelAdapter;
  /**
   * Catalog ref `primary` was really built from. `null` = built from the runtime/env
   * fallback adapter (no ref). Omit to derive it from the session's preferred ref.
   */
  primaryRef?: ModelRef | null;
  env?: NodeJS.ProcessEnv;
  warned?: Set<string>;
  warn?: (message: string) => void;
}): FallbackPlan | undefined {
  const env = input.env ?? process.env;
  const { chain } = readModelFallbackSettings(input.store);
  if (chain.length === 0) return undefined;

  const warned = input.warned ?? warnedGlobal;
  const warn = input.warn ?? ((m: string) => log.warn(m));
  const warnOnce = (ref: ModelRef, reason: ModelFallbackEntryIssue) => {
    const key = `${refKey(ref)}::${reason}`;
    if (warned.has(key)) return;
    warned.add(key);
    warn(
      reason === 'missing_credentials'
        ? `fallback model ${ref.providerId}/${ref.modelId} skipped: provider is missing apiKey or baseUrl`
        : `fallback model ${ref.providerId}/${ref.modelId} skipped: no longer a configured model`
    );
  };

  const catalog = readModelCatalog(input.store);
  const preferred = resolveSessionPreferredRef(catalog, input.session, env);
  const declaredRef =
    input.primaryRef !== undefined
      ? (input.primaryRef ?? undefined)
      // This helper receives an already constructed adapter. Without an explicit ref, only the
      // declared default can identify it: a newly resolved replacement does not prove that the
      // supplied adapter was constructed from that replacement (it may be the runtime fallback).
      // Routed callers pass primaryRef explicitly when they really selected another model.
      : preferred.source === 'default' && catalog.defaultRef ? catalog.defaultRef : preferred.ref;
  const declaredProvider = declaredRef ? findProvider(catalog, declaredRef.providerId, env) : undefined;
  // A ref whose provider is missing/unusable resolves to the runtime fallback adapter, so naming it
  // would mislabel `servedBy` and wrongly dedupe a chain entry against the real primary.
  const primaryRef =
    declaredRef &&
    declaredProvider &&
    (declaredProvider.kind === 'heuristic' ||
      (declaredProvider.apiKey.trim() !== '' && declaredProvider.baseUrl.trim() !== ''))
      ? declaredRef
      : undefined;
  const candidates: FallbackCandidate[] = [
    { adapter: input.primary, ...(primaryRef ? { ref: primaryRef } : {}), label: 'primary' }
  ];
  const seen = new Set<string>(primaryRef ? [refKey(primaryRef)] : []);
  const options = pickerOptions(catalog, env);

  for (const ref of chain) {
    if (seen.has(refKey(ref))) continue;
    const issue = entryIssue(input.store, options, ref, env);
    if (issue) {
      warnOnce(ref, issue);
      continue;
    }
    const provider = findProvider(catalog, ref.providerId, env);
    if (!provider) continue;
    seen.add(refKey(ref));
    candidates.push({
      adapter: createAdapterFromProvider(provider, ref.modelId),
      ref,
      label: `fallback-${candidates.length}`
    });
  }
  return candidates.length > 1 ? { candidates } : undefined;
}

export interface FallbackAttempt {
  attempt: number;
  label: string;
  providerId?: string;
  modelId?: string;
  adapter: string;
  category: ModelErrorCategory;
  status?: number;
  message: string;
}

export interface ServedBy {
  providerId?: string;
  modelId?: string;
  adapter: string;
  fallback: boolean;
  /** 1-based position in [primary, ...chain] of the model that produced the result. */
  attempt: number;
}

const servedBySession = new Map<string, ServedBy>();

/** Remember which model produced the latest turn so the next `turn_end` trace can carry it. */
export function rememberServedBy(sessionId: string, served: ServedBy | undefined): void {
  if (served) servedBySession.set(sessionId, served);
  else servedBySession.delete(sessionId);
}

/**
 * Merge `servedBy` into a non-terminal `turn_end` payload (one-shot). Only tracked
 * while a fallback chain is active, so chain-off traces are byte-identical to before.
 */
export function attachServedByToTrace<E extends { kind: string; payload?: Record<string, unknown> }>(
  sessionId: string,
  event: E
): E {
  if (event.kind !== 'turn_end') return event;
  if (event.payload?.terminal) return event;
  const served = servedBySession.get(sessionId);
  if (!served) return event;
  servedBySession.delete(sessionId);
  return { ...event, payload: { ...(event.payload ?? {}), servedBy: served } };
}

function describe(candidate: FallbackCandidate): string {
  return candidate.ref ? `${candidate.ref.providerId}/${candidate.ref.modelId}` : candidate.adapter.name;
}

function shorten(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function summarize(attempts: FallbackAttempt[]): string {
  return attempts
    .map(
      (a) =>
        `#${a.attempt} ${a.providerId ? `${a.providerId}/${a.modelId}` : a.adapter}: ${a.category}${
          a.status !== undefined ? `(${a.status})` : ''
        }`
    )
    .join('; ');
}

function attemptOf(candidate: FallbackCandidate, index: number, err: unknown): FallbackAttempt {
  const cls = classifyModelError(err);
  return {
    attempt: index + 1,
    label: candidate.label,
    ...(candidate.ref ? { providerId: candidate.ref.providerId, modelId: candidate.ref.modelId } : {}),
    adapter: candidate.adapter.name,
    category: cls.category,
    ...(cls.status !== undefined ? { status: cls.status } : {}),
    message: shorten(errorMessage(err))
  };
}

export type FallbackAttemptedError = Error & { fallbackAttempts?: FallbackAttempt[] };

/**
 * Run `invoke` on candidates in order. Switch to the next one only when the
 * previous failure is an upstream outage class (see classifyModelError).
 * Aborts, watchdog endings and content refusals propagate untouched — from
 * the primary or from any backup. A failing backup does not stop the chain
 * (bad key / smaller context on one backup says nothing about the next).
 * When everything fails, the FIRST error is rethrown with attempt summary.
 */
export async function runWithFallbackChain<T extends ModelTurnResult>(input: {
  candidates: FallbackCandidate[];
  invoke: (adapter: ModelAdapter, index: number) => Promise<T>;
  emitTrace?: (event: { kind: string; payload?: Record<string, unknown> }) => void;
  onServed?: (served: ServedBy) => void;
  signal?: AbortSignal;
}): Promise<T> {
  const { candidates, invoke, emitTrace, onServed, signal } = input;
  const attempts: FallbackAttempt[] = [];
  let firstError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    try {
      const result = await invoke(candidate.adapter, i);
      onServed?.({
        ...(candidate.ref ?? {}),
        adapter: candidate.adapter.name,
        fallback: i > 0,
        attempt: i + 1
      });
      return result;
    } catch (err) {
      const cls = classifyModelError(err);
      attempts.push(attemptOf(candidate, i, err));
      if (i === 0) {
        firstError = err;
        if (!isUpstreamRetryableCategory(cls.category)) throw err;
      } else if (isTerminalModelErrorCategory(cls.category)) {
        throw err;
      }
      if (signal?.aborted) throw err;

      const next = candidates[i + 1];
      if (!next) break;
      emitTrace?.({
        kind: 'model_fallback',
        payload: {
          from: candidate.ref ?? { adapter: candidate.adapter.name },
          to: next.ref ?? { adapter: next.adapter.name },
          fromLabel: describe(candidate),
          toLabel: describe(next),
          category: cls.category,
          ...(cls.status !== undefined ? { status: cls.status } : {}),
          attempt: i + 2,
          totalCandidates: candidates.length,
          message: shorten(errorMessage(err))
        }
      });
    }
  }

  emitTrace?.({
    kind: 'model_fallback_exhausted',
    payload: { attempts, totalCandidates: candidates.length }
  });
  const error: FallbackAttemptedError =
    firstError instanceof Error ? firstError : new Error(errorMessage(firstError));
  error.fallbackAttempts = attempts;
  error.message = `${error.message}\n[model-fallback] all ${candidates.length} models failed: ${summarize(attempts)}`;
  throw error;
}

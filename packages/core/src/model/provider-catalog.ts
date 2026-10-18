/**
 * Lab-configured model providers (daemon_control KV).
 * UI / API is the control plane; env is CI/bootstrap fallback only.
 * No new RAW_AGENT_* switches.
 */

import { createId, nowIso } from '../id.js';
import { ValidationError } from '../errors.js';
import {
  AnthropicCompatibleAdapter,
  HeuristicModelAdapter,
  HybridModelRouterAdapter,
  OpenAICompatibleAdapter,
  createModelAdapterFromEnv,
  normalizeOpenAiHttpKind,
  type OpenAiHttpKind
} from './model-adapters.js';
import { normalizeRemoteSecret } from './remote-env.js';
import { normalizeOpenAiCompatibleBaseUrl } from './list-models.js';
import { createLogger } from '../logger.js';
import { withImageCompatibility } from './image-compatibility.js';
import type { ModelAdapter, SessionRecord } from '../types.js';

const log = createLogger('model-override');

export const MODEL_PROVIDERS_KEY = 'model_providers';
export const HEURISTIC_PROVIDER_ID = 'heuristic';
export const ENV_FALLBACK_PROVIDER_ID = '__env__';

export type ModelProviderKind = 'openai-compatible' | 'anthropic-compatible' | 'heuristic';

export type ModelCapability = 'thinking' | 'vision' | 'tools' | 'text';

export interface CatalogModel {
  id: string;
  ownedBy?: string;
  enabled: boolean;
  capabilities?: ModelCapability[];
  /** Configured actual input/output context window for this model. */
  contextWindow?: number;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  kind: ModelProviderKind;
  baseUrl: string;
  apiKey: string;
  useJsonMode: boolean;
  httpKind?: OpenAiHttpKind;
  models: CatalogModel[];
  scannedAt?: string;
  scanError?: string;
  createdAt: string;
  updatedAt: string;
}

export type CatalogThinkingMode = 'on' | 'off' | 'auto';

export interface ModelProviderCatalog {
  providers: ModelProvider[];
  defaultRef: ModelRef | null;
  updatedAt: string;
  fallbackRefs?: ModelRef[];
  thinkingMode?: CatalogThinkingMode;
}

export interface ModelProviderPatch {
  name?: string;
  kind?: ModelProviderKind;
  baseUrl?: string;
  apiKey?: string;
  useJsonMode?: boolean;
  httpKind?: OpenAiHttpKind | null;
  models?: CatalogModel[];
  scanError?: string | null;
  scannedAt?: string | null;
}

export interface ModelProvidersStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export interface PublicCatalogModel {
  id: string;
  ownedBy?: string;
  enabled: boolean;
  capabilities?: ModelCapability[];
  /** Configured actual input/output context window for this model. */
  contextWindow?: number;
}

export interface PublicModelProvider {
  id: string;
  name: string;
  kind: ModelProviderKind;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  useJsonMode: boolean;
  httpKind?: OpenAiHttpKind;
  models: PublicCatalogModel[];
  scannedAt?: string;
  scanError?: string;
  createdAt: string;
  updatedAt: string;
  source: 'ui' | 'env' | 'builtin';
}

export interface ModelPickerOption {
  providerId: string;
  providerName: string;
  modelId: string;
  kind: ModelProviderKind;
  source: 'ui' | 'env' | 'builtin';
}

const KINDS: ReadonlySet<string> = new Set([
  'openai-compatible',
  'anthropic-compatible',
  'heuristic'
]);

export function parseProviderKind(v: unknown): ModelProviderKind | undefined {
  if (typeof v !== 'string') return undefined;
  return KINDS.has(v) ? (v as ModelProviderKind) : undefined;
}

/** Derive a short display name from Base URL so Lab users need not type one. */
export function suggestProviderName(baseUrl: string, kind?: ModelProviderKind): string {
  const raw = baseUrl.trim();
  if (raw) {
    try {
      const href = raw.includes('://') ? raw : `https://${raw}`;
      const host = new URL(href).hostname.replace(/^api\./i, '').replace(/^www\./i, '');
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === '[::1]' ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      ) {
        return '本地服务';
      }
      const label = host.split('.')[0]?.trim() ?? '';
      if (label) return label.charAt(0).toUpperCase() + label.slice(1);
    } catch {
      /* fallthrough */
    }
  }
  if (kind === 'anthropic-compatible') return 'Anthropic';
  if (kind === 'heuristic') return '本地启发式';
  return 'OpenAI 兼容';
}

export function parseModelRef(raw: unknown): ModelRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const providerId = typeof o.providerId === 'string' ? o.providerId.trim() : '';
  const modelId = typeof o.modelId === 'string' ? o.modelId.trim() : '';
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
}

export function modelRefFromSession(session: SessionRecord | undefined): ModelRef | undefined {
  return parseModelRef(session?.metadata?.modelRef);
}

export type SessionModelOverride = ModelRef | string;

/**
 * Session-level pin written by Bot settings (ModelRef object) or by
 * spawn_subagent `model` (bare model id). Anything else is ignored.
 */
export function readSessionModelOverride(
  metadata: Record<string, unknown> | undefined
): SessionModelOverride | undefined {
  const raw = metadata?.modelOverride;
  if (typeof raw === 'string') return raw.trim() || undefined;
  return parseModelRef(raw);
}

function providerUsable(provider: ModelProvider | undefined): provider is ModelProvider {
  if (!provider) return false;
  return provider.kind === 'heuristic' || Boolean(provider.apiKey?.trim() && provider.baseUrl?.trim());
}

/**
 * Resolve an override against the configured picker options. Undefined when the
 * model is not configured / its provider has no credentials, so callers can
 * fall back to the global default instead of failing the turn.
 */
export function resolveModelOverrideRef(
  catalog: ModelProviderCatalog,
  override: SessionModelOverride | undefined,
  env: NodeJS.ProcessEnv = process.env
): ModelRef | undefined {
  if (!override) return undefined;
  const usable = pickerOptions(catalog, env).filter((o) =>
    providerUsable(findProvider(catalog, o.providerId, env))
  );
  if (typeof override !== 'string') {
    return usable.find((o) => o.providerId === override.providerId && o.modelId === override.modelId)
      ? { providerId: override.providerId, modelId: override.modelId }
      : undefined;
  }
  const byId = usable.filter((o) => o.modelId === override);
  if (byId.length === 0) return undefined;
  const preferred = byId.find((o) => o.providerId === catalog.defaultRef?.providerId) ?? byId[0]!;
  return { providerId: preferred.providerId, modelId: preferred.modelId };
}

export interface SessionPreferredRef {
  ref?: ModelRef;
  source: 'override' | 'session' | 'default' | 'none';
  /** Set when a modelOverride was present but could not be resolved. */
  overrideSkipped?: SessionModelOverride;
}

/** modelOverride (Bot pin) > session modelRef (composer) > catalog default. */
export function resolveSessionPreferredRef(
  catalog: ModelProviderCatalog,
  session: SessionRecord | undefined,
  env: NodeJS.ProcessEnv = process.env
): SessionPreferredRef {
  const override = readSessionModelOverride(session?.metadata);
  let overrideSkipped: SessionModelOverride | undefined;
  if (override) {
    const ref = resolveModelOverrideRef(catalog, override, env);
    if (ref) return { ref, source: 'override' };
    overrideSkipped = override;
    const label = typeof override === 'string' ? override : `${override.providerId}/${override.modelId}`;
    const key = `${session?.id ?? ''}:${label}`;
    if (!warnedOverrides.has(key)) {
      if (warnedOverrides.size > 500) warnedOverrides.clear();
      warnedOverrides.add(key);
      log.warn(
        `modelOverride ${label} is not a configured model${session ? ` (session ${session.id})` : ''}; using global default`
      );
    }
  }
  const fromSession = modelRefFromSession(session);
  if (fromSession) return { ref: fromSession, source: 'session', overrideSkipped };
  if (catalog.defaultRef || catalog.providers.some((p) => providerUsable(p) && p.models.some((m) => m.enabled))) {
    const ref = availableDefaultRef(catalog, env);
    // An unavailable default must not promote the heuristic last resort ahead of injected adapters.
    if (ref.providerId !== HEURISTIC_PROVIDER_ID || resolveModelOverrideRef(catalog, catalog.defaultRef ?? undefined, env)) {
      return { ref, source: 'default', overrideSkipped };
    }
  }
  return { source: 'none', overrideSkipped };
}

const warnedOverrides = new Set<string>();

export function heuristicProvider(): ModelProvider {
  const ts = nowIso();
  return {
    id: HEURISTIC_PROVIDER_ID,
    name: '本地启发式',
    kind: 'heuristic',
    baseUrl: '',
    apiKey: '',
    useJsonMode: false,
    models: [{ id: 'heuristic', enabled: true }],
    createdAt: ts,
    updatedAt: ts
  };
}

export function heuristicRef(): ModelRef {
  return { providerId: HEURISTIC_PROVIDER_ID, modelId: 'heuristic' };
}

export function maskApiKey(key: string): string {
  const k = key.trim();
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

export function publicProvider(p: ModelProvider, source: PublicModelProvider['source']): PublicModelProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    hasApiKey: p.apiKey.trim().length > 0,
    apiKeyMasked: maskApiKey(p.apiKey),
    useJsonMode: p.useJsonMode,
    httpKind: p.httpKind,
    models: p.models.map((m) => ({
      id: m.id,
      ownedBy: m.ownedBy,
      enabled: m.enabled,
      contextWindow: m.contextWindow,
      capabilities: m.capabilities
    })),
    scannedAt: p.scannedAt,
    scanError: p.scanError,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    source
  };
}

function normalizeModels(raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, enabled: true });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const caps = Array.isArray(o.capabilities)
      ? o.capabilities.map(String).filter((c): c is ModelCapability =>
          c === 'thinking' || c === 'vision' || c === 'tools' || c === 'text'
        )
      : undefined;
    out.push({
      id,
      ownedBy: typeof o.ownedBy === 'string' && o.ownedBy.trim() ? o.ownedBy.trim() : undefined,
      enabled: o.enabled !== false,
      ...(Number.isSafeInteger(o.contextWindow) && Number(o.contextWindow) >= 1024 ? { contextWindow: Number(o.contextWindow) } : {}),
      ...(caps && caps.length > 0 ? { capabilities: caps } : {})
    });
  }
  return out;
}

export function normalizeProvider(raw: Partial<ModelProvider> | null | undefined): ModelProvider | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const kind = parseProviderKind(raw.kind) ?? 'openai-compatible';
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createId('prov');
  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : kind === 'heuristic'
        ? '本地启发式'
        : '未命名服务商';
  const ts = nowIso();
  const httpKind =
    kind === 'openai-compatible' && typeof raw.httpKind === 'string'
      ? normalizeOpenAiHttpKind(raw.httpKind)
      : undefined;
  return {
    id,
    name,
    kind,
    baseUrl:
      kind === 'openai-compatible'
        ? normalizeOpenAiCompatibleBaseUrl(typeof raw.baseUrl === 'string' ? raw.baseUrl : '')
        : typeof raw.baseUrl === 'string'
          ? raw.baseUrl.trim()
          : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    useJsonMode: raw.useJsonMode !== false,
    httpKind,
    models: kind === 'heuristic' ? [{ id: 'heuristic', enabled: true }] : normalizeModels(raw.models),
    scannedAt: typeof raw.scannedAt === 'string' ? raw.scannedAt : undefined,
    scanError: typeof raw.scanError === 'string' && raw.scanError.trim() ? raw.scanError.trim() : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : ts,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ts
  };
}

export function emptyCatalog(): ModelProviderCatalog {
  return { providers: [], defaultRef: null, updatedAt: nowIso() };
}

export function normalizeCatalog(raw: Partial<ModelProviderCatalog> | null | undefined): ModelProviderCatalog {
  const base = emptyCatalog();
  if (!raw || typeof raw !== 'object') return base;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map((p) => normalizeProvider(p)).filter((p): p is ModelProvider => !!p)
    : [];
  const defaultRef = parseModelRef(raw.defaultRef) ?? null;
  const fallbackRefs = Array.isArray(raw.fallbackRefs)
    ? raw.fallbackRefs.map((r) => parseModelRef(r)).filter((r): r is ModelRef => !!r)
    : undefined;
  const thinkingMode =
    raw.thinkingMode === 'on' || raw.thinkingMode === 'off' || raw.thinkingMode === 'auto'
      ? raw.thinkingMode
      : undefined;
  return {
    providers,
    defaultRef,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    ...(fallbackRefs && fallbackRefs.length > 0 ? { fallbackRefs } : {}),
    ...(thinkingMode ? { thinkingMode } : {})
  };
}

export function patchCatalogRouting(
  store: ModelProvidersStore,
  patch: { fallbackRefs?: ModelRef[] | null; thinkingMode?: CatalogThinkingMode | null }
): ModelProviderCatalog {
  const catalog = readModelCatalog(store);
  return writeModelCatalog(store, {
    ...catalog,
    fallbackRefs: patch.fallbackRefs === null ? undefined : patch.fallbackRefs ?? catalog.fallbackRefs,
    thinkingMode: patch.thinkingMode === null ? undefined : patch.thinkingMode ?? catalog.thinkingMode
  });
}

export function readModelCatalog(store: ModelProvidersStore): ModelProviderCatalog {
  const saved = store.getDaemonControl<Partial<ModelProviderCatalog>>(MODEL_PROVIDERS_KEY);
  if (!saved) return emptyCatalog();
  return normalizeCatalog(saved);
}

export function writeModelCatalog(store: ModelProvidersStore, next: ModelProviderCatalog): ModelProviderCatalog {
  const normalized = normalizeCatalog({ ...next, updatedAt: nowIso() });
  store.setDaemonControl(MODEL_PROVIDERS_KEY, normalized);
  return normalized;
}

export function hasPersistedModelCatalog(store: ModelProvidersStore): boolean {
  return store.getDaemonControl(MODEL_PROVIDERS_KEY) != null;
}

export function upsertProvider(store: ModelProvidersStore, input: Partial<ModelProvider> & { id?: string }): ModelProvider {
  const catalog = readModelCatalog(store);
  const incoming = normalizeProvider({
    ...input,
    id: input.id?.trim() || createId('prov'),
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  if (!incoming) {
    throw new Error('invalid provider');
  }
  const idx = catalog.providers.findIndex((p) => p.id === incoming.id);
  if (idx >= 0) {
    const prev = catalog.providers[idx]!;
    const merged = normalizeProvider({
      ...prev,
      ...incoming,
      apiKey: incoming.apiKey.trim() ? incoming.apiKey : prev.apiKey,
      createdAt: prev.createdAt,
      updatedAt: nowIso()
    })!;
    catalog.providers[idx] = merged;
    writeModelCatalog(store, catalog);
    return merged;
  }
  catalog.providers.push(incoming);
  const firstEnabled = incoming.models.find((m) => m.enabled);
  if (!catalog.defaultRef && firstEnabled) {
    catalog.defaultRef = { providerId: incoming.id, modelId: firstEnabled.id };
  }
  writeModelCatalog(store, catalog);
  return incoming;
}

export function patchProvider(
  store: ModelProvidersStore,
  id: string,
  patch: ModelProviderPatch
): ModelProvider | undefined {
  const catalog = readModelCatalog(store);
  const idx = catalog.providers.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const prev = catalog.providers[idx]!;
  const next = normalizeProvider({
    ...prev,
    name: patch.name !== undefined ? patch.name : prev.name,
    kind: patch.kind !== undefined ? patch.kind : prev.kind,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : prev.baseUrl,
    apiKey: patch.apiKey !== undefined && patch.apiKey.trim() ? patch.apiKey : prev.apiKey,
    useJsonMode: patch.useJsonMode !== undefined ? patch.useJsonMode : prev.useJsonMode,
    httpKind:
      patch.httpKind === null ? undefined : patch.httpKind !== undefined ? patch.httpKind : prev.httpKind,
    models: patch.models !== undefined ? patch.models : prev.models,
    scanError:
      patch.scanError === null ? undefined : patch.scanError !== undefined ? patch.scanError : prev.scanError,
    scannedAt:
      patch.scannedAt === null ? undefined : patch.scannedAt !== undefined ? patch.scannedAt : prev.scannedAt,
    createdAt: prev.createdAt,
    updatedAt: nowIso()
  })!;
  catalog.providers[idx] = next;
  writeModelCatalog(store, catalog);
  return next;
}

export function deleteProvider(store: ModelProvidersStore, id: string): boolean {
  const catalog = readModelCatalog(store);
  const next = catalog.providers.filter((p) => p.id !== id);
  if (next.length === catalog.providers.length) return false;
  const defaultRef =
    catalog.defaultRef?.providerId === id
      ? next[0]?.models[0]
        ? { providerId: next[0].id, modelId: next[0].models[0]!.id }
        : null
      : catalog.defaultRef;
  writeModelCatalog(store, { ...catalog, providers: next, defaultRef });
  return true;
}

export function setCatalogDefaultRef(store: ModelProvidersStore, ref: ModelRef | null, env: NodeJS.ProcessEnv = process.env): ModelProviderCatalog {
  const catalog = readModelCatalog(store);
  if (ref && !resolveModelOverrideRef(catalog, ref, env)) {
    throw new ValidationError('Selected model is no longer available or enabled. Refresh the model list and retry.');
  }
  return writeModelCatalog(store, { ...catalog, defaultRef: ref });
}

export function mergeScannedModels(existing: CatalogModel[], scanned: Array<{ id: string; ownedBy?: string }>): CatalogModel[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const s of scanned) {
    const id = s.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const prev = byId.get(id);
    out.push({
      id,
      ownedBy: s.ownedBy ?? prev?.ownedBy,
      contextWindow: prev?.contextWindow,
      enabled: prev ? prev.enabled : true
    });
  }
  for (const prev of existing) {
    if (seen.has(prev.id)) continue;
    seen.add(prev.id);
    out.push(prev);
  }
  return out;
}

export function envFallbackProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider | undefined {
  const provider = (env.RAW_AGENT_MODEL_PROVIDER ?? '').trim();
  const apiKey = normalizeRemoteSecret(env.RAW_AGENT_API_KEY);
  const model = normalizeRemoteSecret(env.RAW_AGENT_MODEL_NAME);
  if (provider === 'anthropic-compatible') {
    const baseUrl = normalizeRemoteSecret(env.RAW_AGENT_ANTHROPIC_URL ?? env.RAW_AGENT_BASE_URL);
    if (!apiKey || !baseUrl || !model) return undefined;
    const ts = nowIso();
    return {
      id: ENV_FALLBACK_PROVIDER_ID,
      name: '环境变量（回退）',
      kind: 'anthropic-compatible',
      baseUrl,
      apiKey,
      useJsonMode: true,
      models: [{ id: model, enabled: true }],
      createdAt: ts,
      updatedAt: ts
    };
  }
  if (provider === 'openai-compatible') {
    const baseUrl = normalizeRemoteSecret(env.RAW_AGENT_BASE_URL);
    if (!apiKey || !baseUrl || !model) return undefined;
    const ts = nowIso();
    const useJsonMode = !['0', 'false', 'off'].includes(String(env.RAW_AGENT_USE_JSON_MODE ?? '1').toLowerCase());
    return {
      id: ENV_FALLBACK_PROVIDER_ID,
      name: '环境变量（回退）',
      kind: 'openai-compatible',
      baseUrl,
      apiKey,
      useJsonMode,
      httpKind: normalizeOpenAiHttpKind(env.RAW_AGENT_OPENAI_HTTP_KIND),
      models: [{ id: model, enabled: true }],
      createdAt: ts,
      updatedAt: ts
    };
  }
  return undefined;
}

export function findProvider(
  catalog: ModelProviderCatalog,
  providerId: string,
  env: NodeJS.ProcessEnv = process.env
): ModelProvider | undefined {
  if (providerId === HEURISTIC_PROVIDER_ID) {
    return catalog.providers.find((p) => p.id === HEURISTIC_PROVIDER_ID) ?? heuristicProvider();
  }
  const ui = catalog.providers.find((p) => p.id === providerId);
  if (ui) return ui;
  if (providerId === ENV_FALLBACK_PROVIDER_ID) return envFallbackProvider(env);
  return undefined;
}

function createUnannotatedAdapter(provider: ModelProvider, modelId: string): ModelAdapter {
  const model = modelId.trim() || provider.models.find((m) => m.enabled)?.id || provider.models[0]?.id || '';
  switch (provider.kind) {
    case 'heuristic':
      return new HeuristicModelAdapter();
    case 'openai-compatible':
      return new OpenAICompatibleAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model,
        useJsonMode: provider.useJsonMode,
        httpKind: provider.httpKind
      });
    case 'anthropic-compatible':
      return new AnthropicCompatibleAdapter({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model
      });
    default: {
      const _never: never = provider.kind;
      void _never;
      return new HeuristicModelAdapter();
    }
  }
}

export function createAdapterFromProvider(provider: ModelProvider, modelId: string): ModelAdapter {
  const adapter = withImageCompatibility(createUnannotatedAdapter(provider, modelId));
  const configured = provider.models.find(model => model.id === modelId)?.contextWindow;
  const contextWindow = configured ?? (provider.kind === 'heuristic' ? 131072 : undefined);
  if (contextWindow) Object.assign(adapter, { contextWindow });
  return adapter;
}

export function createModelAdapterFromEnvOrHeuristic(env: NodeJS.ProcessEnv = process.env): ModelAdapter {
  try {
    return withImageCompatibility(createModelAdapterFromEnv(env));
  } catch {
    return new HeuristicModelAdapter();
  }
}

/**
 * Session modelRef → adapter. UI catalog wins; env fallback only when
 * the session has no ref and no UI default.
 */
export function resolveSessionModelAdapter(
  store: ModelProvidersStore,
  session: SessionRecord | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fallback?: ModelAdapter
): ModelAdapter {
  const catalog = readModelCatalog(store);
  const ref = resolveSessionPreferredRef(catalog, session, env).ref;
  if (ref) {
    const provider = findProvider(catalog, ref.providerId, env);
    if (provider) {
      if (provider.kind !== 'heuristic' && (!provider.apiKey.trim() || !provider.baseUrl.trim())) {
        return fallback ?? createModelAdapterFromEnvOrHeuristic(env);
      }
      const adapter = createAdapterFromProvider(provider, ref.modelId);
      return maybeWrapVl(adapter, env, provider, ref.modelId);
    }
  }
  return fallback ?? createModelAdapterFromEnvOrHeuristic(env);
}

function maybeWrapVl(
  textAdapter: ModelAdapter,
  env: NodeJS.ProcessEnv,
  provider: ModelProvider,
  modelId: string
): ModelAdapter {
  const vlModel = env.RAW_AGENT_VL_MODEL_NAME?.trim();
  if (!vlModel || provider.kind !== 'openai-compatible') return textAdapter;
  if (vlModel === modelId) return textAdapter;
  const vlBase = (env.RAW_AGENT_VL_BASE_URL ?? provider.baseUrl).trim();
  const vlKey = (env.RAW_AGENT_VL_API_KEY ?? provider.apiKey).trim();
  if (!vlBase || !vlKey) return textAdapter;
  const vlUseJson = !['0', 'false', 'off'].includes(
    String(env.RAW_AGENT_VL_USE_JSON_MODE ?? '0').toLowerCase()
  );
  const vlHttpRaw = env.RAW_AGENT_VL_OPENAI_HTTP_KIND?.trim();
  const vlAdapter = withImageCompatibility(new OpenAICompatibleAdapter({
    apiKey: vlKey,
    baseUrl: vlBase,
    model: vlModel,
    useJsonMode: vlUseJson,
    httpKind: vlHttpRaw ? normalizeOpenAiHttpKind(vlHttpRaw) : provider.httpKind
  }));
  const scope: 'last_user' | 'any' = env.RAW_AGENT_VL_ROUTE_SCOPE === 'last_user' ? 'last_user' : 'any';
  const hybrid = new HybridModelRouterAdapter(textAdapter, vlAdapter, scope);
  const configured = (textAdapter as ModelAdapter & { contextWindow?: number }).contextWindow;
  if (configured) Object.assign(hybrid, { contextWindow: configured });
  return hybrid;
}

export function pickerOptions(
  catalog: ModelProviderCatalog,
  env: NodeJS.ProcessEnv = process.env
): ModelPickerOption[] {
  const out: ModelPickerOption[] = [];
  const seen = new Set<string>();
  const push = (p: ModelProvider, source: ModelPickerOption['source']) => {
    const models = p.kind === 'heuristic' ? p.models : p.models.filter((m) => m.enabled);
    for (const m of models) {
      const key = `${p.id}::${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        providerId: p.id,
        providerName: p.name,
        modelId: m.id,
        kind: p.kind,
        source
      });
    }
  };
  for (const p of catalog.providers) push(p, 'ui');
  if (!catalog.providers.some((p) => p.id === HEURISTIC_PROVIDER_ID || p.kind === 'heuristic')) {
    push(heuristicProvider(), 'builtin');
  }
  const envP = envFallbackProvider(env);
  if (envP) push(envP, 'env');
  return out;
}

function asModelRef(ref: { providerId: string; modelId: string } | null | undefined): ModelRef {
  if (!ref) return heuristicRef();
  return { providerId: ref.providerId, modelId: ref.modelId };
}

/** Validate saved defaults on every read, including after a model is disabled or removed. */
function availableDefaultRef(catalog: ModelProviderCatalog, env: NodeJS.ProcessEnv): ModelRef {
  const saved = resolveModelOverrideRef(catalog, catalog.defaultRef ?? undefined, env);
  if (saved) return saved;
  const options = pickerOptions(catalog, env).filter((o) => providerUsable(findProvider(catalog, o.providerId, env)));
  return asModelRef(options.find((o) => o.kind !== 'heuristic') ?? options[0]);
}

export function publicCatalogPayload(store: ModelProvidersStore, env: NodeJS.ProcessEnv = process.env) {
  const catalog = readModelCatalog(store);
  const envP = envFallbackProvider(env);
  const providers: PublicModelProvider[] = catalog.providers.map((p) => publicProvider(p, 'ui'));
  if (!providers.some((p) => p.id === HEURISTIC_PROVIDER_ID || p.kind === 'heuristic')) {
    providers.push(publicProvider(heuristicProvider(), 'builtin'));
  }
  if (envP) providers.push(publicProvider(envP, 'env'));
  const options = pickerOptions(catalog, env);
  const persisted = hasPersistedModelCatalog(store);
  const defaultRef = availableDefaultRef(catalog, env);
  return {
    catalog: {
      providers,
      defaultRef,
      updatedAt: catalog.updatedAt,
      fallbackRefs: catalog.fallbackRefs,
      thinkingMode: catalog.thinkingMode
    },
    options,
    persisted,
    effective: {
      source: persisted ? ('ui' as const) : envP ? ('env' as const) : ('heuristic' as const),
      defaultRef
    }
  };
}

export function resolveDefaultModelRef(
  store: ModelProvidersStore,
  env: NodeJS.ProcessEnv = process.env
): ModelRef {
  const catalog = readModelCatalog(store);
  return availableDefaultRef(catalog, env);
}

export function mergeModelRefMetadata(
  store: ModelProvidersStore,
  metadata: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const extra = { ...(metadata ?? {}) };
  if (body.modelRef === null) {
    delete extra.modelRef;
    return extra;
  }
  const fromBody =
    parseModelRef(body.modelRef) ??
    (typeof body.providerId === 'string' && typeof body.modelId === 'string'
      ? parseModelRef({ providerId: body.providerId, modelId: body.modelId })
      : parseModelRef(extra.modelRef));
  if (fromBody) extra.modelRef = fromBody;
  else delete extra.modelRef;
  return extra;
}

export type ModelProviderKind = 'openai-compatible' | 'anthropic-compatible' | 'heuristic';

export type ModelRef = { providerId: string; modelId: string };

export type RemoteModelHint = { id: string; ownedBy?: string };

export type PreviewScanResponse = {
  ok: boolean;
  models: RemoteModelHint[];
  endpoint?: string;
  error?: string;
  suggestedName?: string;
};

export type ModelProviderPreset = {
  id: string;
  label: string;
  kind: ModelProviderKind;
  baseUrl: string;
  apiKeyHint?: string;
};

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'siliconflow', label: 'SiliconFlow', kind: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'moonshot', label: 'Moonshot', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyHint: 'ollama'
  },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com' },
  { id: 'custom', label: 'Custom', kind: 'openai-compatible', baseUrl: '' }
];

export type PublicCatalogModel = { contextWindow?:number; id: string; ownedBy?: string; enabled: boolean };

export type PublicModelProvider = {
  id: string;
  name: string;
  kind: ModelProviderKind;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  useJsonMode: boolean;
  httpKind?: 'chat_completions' | 'responses';
  models: PublicCatalogModel[];
  scannedAt?: string;
  scanError?: string;
  createdAt: string;
  updatedAt: string;
  source: 'ui' | 'env' | 'builtin';
};

export type ModelPickerOption = {
  providerId: string;
  providerName: string;
  modelId: string;
  kind: ModelProviderKind;
  source: 'ui' | 'env' | 'builtin';
};

export type ModelProvidersResponse = {
  catalog: {
    providers: PublicModelProvider[];
    defaultRef: ModelRef | null;
    updatedAt: string;
  };
  options: ModelPickerOption[];
  persisted: boolean;
  effective: { source: 'ui' | 'env' | 'heuristic'; defaultRef: ModelRef };
};

export type GroupedPickerOptions = {
  providerId: string;
  providerName: string;
  options: ModelPickerOption[];
};

export function parseManualModelIds(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;，；]+/)) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Configured remote provider that passed scan or has enabled models (not heuristic). */
export function isVerifiedConfiguredProvider(p: PublicModelProvider): boolean {
  if (p.kind === 'heuristic' || p.source === 'builtin') return false;
  if (!p.baseUrl.trim()) return false;
  if (p.source === 'ui' && !p.hasApiKey) return false;
  if (p.scanError) return false;
  const enabled = p.models.some((m) => m.enabled);
  if (p.source === 'env') return enabled;
  return Boolean(p.scannedAt) || enabled;
}

export function isEnvFallbackOption(o: { source?: string; providerId?: string; id?: string }): boolean {
  return o.source === 'env' || o.providerId === '__env__' || o.id === '__env__';
}

function isComposerPickerProvider(p: PublicModelProvider): boolean {
  if (isEnvFallbackOption(p)) return false;
  if (p.kind === 'heuristic' || p.source === 'builtin') return true;
  if (!p.baseUrl.trim()) return false;
  if (p.source === 'ui' && !p.hasApiKey) return false;
  return p.models.some((m) => m.enabled);
}

export function catalogToPickerOptions(
  data: ModelProvidersResponse | null | undefined
): ModelPickerOption[] {
  const out: ModelPickerOption[] = [];
  const seen = new Set<string>();
  for (const p of data?.catalog.providers ?? []) {
    if (!isComposerPickerProvider(p)) continue;
    for (const m of p.models) {
      if (!m.enabled) continue;
      const key = `${p.id}::${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        providerId: p.id,
        providerName: p.name,
        modelId: m.id,
        kind: p.kind,
        source: p.source
      });
    }
  }
  return out;
}

/** Current picker selection: session/UI ref if it is a catalog option, else persisted default, else none (never env). */
export function resolvePickerModelRef(
  options: readonly ModelPickerOption[],
  current: ModelRef | null | undefined,
  catalogDefault?: ModelRef | null
): ModelRef | null {
  const ui = options.filter((o) => !isEnvFallbackOption(o));
  const match = (ref: ModelRef | null | undefined): ModelRef | null => {
    if (!ref || isEnvFallbackOption(ref)) return null;
    const hit = ui.find((o) => o.providerId === ref.providerId && o.modelId === ref.modelId);
    return hit ? { providerId: hit.providerId, modelId: hit.modelId } : null;
  };
  return match(current) ?? match(catalogDefault);
}

export function groupPickerOptionsByProvider(
  options: readonly ModelPickerOption[]
): GroupedPickerOptions[] {
  const order: string[] = [];
  const byProvider = new Map<string, GroupedPickerOptions>();
  for (const o of options) {
    let group = byProvider.get(o.providerId);
    if (!group) {
      group = { providerId: o.providerId, providerName: o.providerName, options: [] };
      byProvider.set(o.providerId, group);
      order.push(o.providerId);
    }
    group.options.push(o);
  }
  return order.map((id) => byProvider.get(id)!);
}

export function encodeModelValue(ref: ModelRef): string {
  return `${ref.providerId}::${ref.modelId}`;
}

export function decodeModelValue(value: string): ModelRef | undefined {
  const i = value.indexOf('::');
  if (i <= 0) return undefined;
  const providerId = value.slice(0, i).trim();
  const modelId = value.slice(i + 2).trim();
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
}

function normalizeProviderUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** Chips in the setup row: saved custom (UI) providers only. */
export function providersForPresetRow(providers: readonly PublicModelProvider[]): PublicModelProvider[] {
  return providers.filter((p) => p.source === 'ui' && p.kind !== 'heuristic');
}

export function baseUrlFromModelsEndpoint(endpoint: string): string | undefined {
  const raw = endpoint.trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  if (raw.endsWith('/models')) {
    const next = raw.slice(0, -'/models'.length).replace(/\/+$/, '');
    return next || undefined;
  }
  return undefined;
}

export function matchProviderPresetId(provider: Pick<PublicModelProvider, 'baseUrl' | 'kind'>): string {
  const url = normalizeProviderUrl(provider.baseUrl);
  const hit = MODEL_PROVIDER_PRESETS.find(
    (pre) => pre.id !== 'custom' && pre.kind === provider.kind && normalizeProviderUrl(pre.baseUrl) === url
  );
  return hit?.id ?? 'custom';
}

export function catalogNeedsSetup(data: ModelProvidersResponse | null | undefined): boolean {
  if (!data) return true;
  return catalogToPickerOptions(data).length === 0;
}

export function parseSessionModelRef(metadata: Record<string, unknown> | undefined): ModelRef | undefined {
  const raw = metadata?.modelRef;
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const providerId = typeof o.providerId === 'string' ? o.providerId.trim() : '';
  const modelId = typeof o.modelId === 'string' ? o.modelId.trim() : '';
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
}

/** Fired on `window` after the provider catalog was changed from the Lab UI. */
export const MODEL_PROVIDERS_CHANGED_EVENT = 'ppeng-model-providers-changed';

export type ScanErrorKind =
  | 'missingKey'
  | 'missingUrl'
  | 'auth'
  | 'notFound'
  | 'rateLimit'
  | 'server'
  | 'network'
  | 'unknown';

/** Map a raw upstream model-list failure to something the UI can explain in one line. */
export function classifyScanError(message: string | undefined | null): ScanErrorKind {
  const raw = (message ?? '').trim();
  if (!raw) return 'unknown';
  if (/缺少\s*API\s*Key/i.test(raw)) return 'missingKey';
  if (/缺少\s*Base\s*URL/i.test(raw)) return 'missingUrl';
  if (/HTTP\s*40[13]\b|status\s*40[13]\b|unauthori[sz]ed|invalid[\s_-]*(api[\s_-]*)?key|incorrect api key/i.test(raw)) {
    return 'auth';
  }
  if (/HTTP\s*404\b|status\s*404\b/i.test(raw)) return 'notFound';
  if (/HTTP\s*429\b|status\s*429\b|rate.?limit/i.test(raw)) return 'rateLimit';
  if (/HTTP\s*5\d\d\b|status\s*5\d\d\b/i.test(raw)) return 'server';
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT|timed? ?out|network|terminated|socket/i.test(raw)) {
    return 'network';
  }
  return 'unknown';
}

const NON_CHAT_MODEL = /embed|whisper|tts|speech|audio|dall-?e|image|moderation|rerank|transcri|vision-preview/i;

const PREFERRED_MODELS: Record<string, readonly string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1'],
  deepseek: ['deepseek-chat', 'deepseek-v3', 'deepseek-reasoner'],
  anthropic: ['claude-sonnet', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-haiku', 'claude'],
  moonshot: ['kimi-k2', 'moonshot-v1-32k', 'moonshot-v1-8k', 'kimi'],
  siliconflow: ['deepseek-ai/deepseek-v3', 'qwen/qwen2.5-72b-instruct', 'qwen'],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o'],
  ollama: ['qwen2.5', 'qwen3', 'llama3', 'llama']
};

/** Sane default after a successful scan: preset favourite, else first chat-capable model. */
export function pickDefaultModel(models: readonly RemoteModelHint[], presetId?: string): string | undefined {
  if (!models.length) return undefined;
  const usable = models.filter((m) => !NON_CHAT_MODEL.test(m.id));
  const pool = usable.length ? usable : models;
  const wanted = (presetId && PREFERRED_MODELS[presetId]) || [];
  for (const want of wanted) {
    const exact = pool.find((m) => m.id.toLowerCase() === want);
    if (exact) return exact.id;
  }
  for (const want of wanted) {
    const hit = pool.find((m) => m.id.toLowerCase().includes(want));
    if (hit) return hit.id;
  }
  return pool[0]!.id;
}

export type ModelSetupState = 'ready' | 'demo' | 'none';

/**
 * First-run onboarding state: `ready` once a real (non-heuristic) model with credentials is
 * usable, `demo` while only the built-in heuristic model exists, `none` when nothing is selectable.
 */
export function modelSetupState(data: ModelProvidersResponse | null | undefined): ModelSetupState {
  const providers = data?.catalog.providers ?? [];
  const real = providers.some(
    (p) =>
      p.kind !== 'heuristic' &&
      p.source !== 'builtin' &&
      Boolean(p.baseUrl.trim()) &&
      (p.source === 'env' || p.hasApiKey) &&
      p.models.some((m) => m.enabled)
  );
  if (real) return 'ready';
  const anyOption = providers.some((p) => p.models.some((m) => m.enabled));
  return anyOption ? 'demo' : 'none';
}

const MAX_AUTO_ENABLED_MODELS = 30;

/** Models enabled in the chat picker after the first scan; huge catalogs only enable the default. */
export function defaultEnabledModelIds(models: readonly RemoteModelHint[], defaultId?: string): string[] {
  if (models.length > MAX_AUTO_ENABLED_MODELS) return defaultId ? [defaultId] : [];
  const ids = models.filter((m) => !NON_CHAT_MODEL.test(m.id)).map((m) => m.id);
  if (defaultId && !ids.includes(defaultId)) ids.push(defaultId);
  return ids;
}

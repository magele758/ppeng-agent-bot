/**
 * Langfuse entry + export toggle. daemon_control KV `langfuse_settings`.
 * No RAW_AGENT_* feature switch. Missing entry ⇒ chain stays off.
 * Env keys are secret fallback only after an entry is saved and enabled.
 *
 * Ingestion helpers live in the same module so strip-types tests can import
 * without resolving sibling `.js` → `.ts` (Node does not rewrite extensions).
 */

import { createHash, randomUUID } from 'node:crypto';

export const LANGFUSE_SETTINGS_KEY = 'langfuse_settings';

export interface LangfuseSettings {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  enabled: boolean;
  updatedAt: string;
}

export interface LangfuseSettingsPatch {
  baseUrl?: string;
  /** Omit or blank keeps the stored key. */
  publicKey?: string;
  /** Omit or blank keeps the stored key. */
  secretKey?: string;
  clearPublicKey?: boolean;
  clearSecretKey?: boolean;
  enabled?: boolean;
}

export interface LangfuseSettingsPublic {
  configured: boolean;
  baseUrl: string;
  publicKeySet: boolean;
  secretKeySet: boolean;
  enabled: boolean;
  /** configured && enabled && both keys resolvable */
  chained: boolean;
  updatedAt: string;
}

export interface LangfuseSettingsStore {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

export interface LangfuseChain {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

function envPublicKey(env: NodeJS.ProcessEnv): string {
  return (env.LANGFUSE_PUBLIC_KEY || '').trim();
}

function envSecretKey(env: NodeJS.ProcessEnv): string {
  return (env.LANGFUSE_SECRET_KEY || '').trim();
}

function cleanUrl(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim().replace(/\/+$/, '');
  return '';
}

export function defaultLangfuseSettings(): LangfuseSettings {
  return {
    baseUrl: '',
    publicKey: '',
    secretKey: '',
    enabled: false,
    updatedAt: new Date(0).toISOString()
  };
}

export function normalizeLangfuseSettings(
  raw: Partial<LangfuseSettings> | null | undefined
): LangfuseSettings {
  const base = defaultLangfuseSettings();
  if (!raw || typeof raw !== 'object') return base;
  const baseUrl = cleanUrl(raw.baseUrl);
  // The row switch is the wish to trace. A missing URL still keeps it on so the form can appear;
  // resolveLangfuseChain stays null until the URL and both keys exist.
  const enabled = raw.enabled === true;
  return {
    baseUrl,
    publicKey: typeof raw.publicKey === 'string' ? raw.publicKey.trim() : '',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '',
    enabled,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

export function readLangfuseSettings(store: LangfuseSettingsStore): LangfuseSettings {
  const saved = store.getDaemonControl?.(LANGFUSE_SETTINGS_KEY) as
    | Partial<LangfuseSettings>
    | undefined;
  if (!saved) return defaultLangfuseSettings();
  return normalizeLangfuseSettings(saved);
}

export function writeLangfuseSettings(
  store: LangfuseSettingsStore,
  patch: LangfuseSettingsPatch
): LangfuseSettings {
  const current = readLangfuseSettings(store);
  const next = normalizeLangfuseSettings({
    ...current,
    ...('baseUrl' in patch ? { baseUrl: patch.baseUrl } : {}),
    ...('enabled' in patch ? { enabled: patch.enabled } : {}),
    publicKey: patch.clearPublicKey
      ? ''
      : typeof patch.publicKey === 'string' && patch.publicKey.trim()
        ? patch.publicKey.trim()
        : current.publicKey,
    secretKey: patch.clearSecretKey
      ? ''
      : typeof patch.secretKey === 'string' && patch.secretKey.trim()
        ? patch.secretKey.trim()
        : current.secretKey,
    updatedAt: new Date().toISOString()
  });
  store.setDaemonControl?.(LANGFUSE_SETTINGS_KEY, next);
  return next;
}

function resolveKeys(
  settings: LangfuseSettings,
  env: NodeJS.ProcessEnv
): { publicKey: string; secretKey: string } {
  return {
    publicKey: settings.publicKey || envPublicKey(env),
    secretKey: settings.secretKey || envSecretKey(env)
  };
}

export function publicLangfuseSettings(
  settings: LangfuseSettings,
  env: NodeJS.ProcessEnv = process.env
): LangfuseSettingsPublic {
  const configured = settings.baseUrl.length > 0;
  const keys = resolveKeys(settings, env);
  const chained =
    configured && settings.enabled && Boolean(keys.publicKey) && Boolean(keys.secretKey);
  return {
    configured,
    baseUrl: settings.baseUrl,
    publicKeySet: Boolean(settings.publicKey) || (configured && Boolean(envPublicKey(env))),
    secretKeySet: Boolean(settings.secretKey) || (configured && Boolean(envSecretKey(env))),
    enabled: settings.enabled,
    chained,
    updatedAt: settings.updatedAt
  };
}

/** Null unless entry saved, enabled, and both keys resolvable. */
export function resolveLangfuseChain(
  store: LangfuseSettingsStore,
  env: NodeJS.ProcessEnv = process.env
): LangfuseChain | null {
  const settings = readLangfuseSettings(store);
  if (!settings.baseUrl || !settings.enabled) return null;
  const keys = resolveKeys(settings, env);
  if (!keys.publicKey || !keys.secretKey) return null;
  return {
    baseUrl: settings.baseUrl,
    publicKey: keys.publicKey,
    secretKey: keys.secretKey
  };
}

// ── Ingestion / mirror (fail-open; never calls emitTrace) ─────────────────────

const SAFE_TRACE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_FIELD_CHARS = 4000;
const ERROR_KINDS = new Set([
  'model_error',
  'recovery_abort',
  'repetition_abort',
  'reasoning_spin_abort'
]);

export type LangfuseFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface LangfuseBatchEvent {
  id: string;
  type: string;
  timestamp: string;
  body: Record<string, unknown>;
}

export function langfuseIngestionUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/api/public/ingestion')) return base;
  if (base.endsWith('/api/public')) return `${base}/ingestion`;
  return `${base}/api/public/ingestion`;
}

export function stableLangfuseTraceId(sessionId: string): string {
  if (SAFE_TRACE_ID.test(sessionId)) return sessionId;
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function truncateJson(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => truncateJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= 40) {
        out['…'] = 'truncated';
        break;
      }
      out[k] = truncateJson(v, depth + 1);
      n += 1;
    }
    return out;
  }
  return String(value).slice(0, MAX_FIELD_CHARS);
}

function eventPayload(event: { payload?: unknown; data?: unknown }): Record<string, unknown> {
  const raw = event.payload ?? event.data;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

interface OpenTool {
  id: string;
  name: string;
  startedAt: string;
}

interface OpenSession {
  turnSpanId: string | null;
  turnStartedAt: string | null;
  turn: number | null;
  genId: string | null;
  genStartedAt: string | null;
  model: string | null;
  tools: OpenTool[];
}

const openSessions = new Map<string, OpenSession>();

/** Test hook. Production state resets when a terminal turn_end closes the session. */
export function resetLangfuseTraceState(): void {
  openSessions.clear();
}

function openSession(sessionId: string): OpenSession {
  let state = openSessions.get(sessionId);
  if (!state) {
    state = {
      turnSpanId: null,
      turnStartedAt: null,
      turn: null,
      genId: null,
      genStartedAt: null,
      model: null,
      tools: []
    };
    openSessions.set(sessionId, state);
  }
  return state;
}

function plusMs(iso: string, ms: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + ms).toISOString();
}

/** Langfuse graph drops zero-duration nodes. Keep end strictly after start. */
function endAfter(start: string | null | undefined, end: string): string {
  if (!start) return end;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return plusMs(start, 1);
  return end;
}

function namedModel(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed && trimmed !== 'default') return trimmed;
  }
  return undefined;
}

function modelFromStore(store: LangfuseSettingsStore, sessionId: string): string | undefined {
  const getter = (store as { getSession?: (id: string) => unknown }).getSession;
  if (typeof getter !== 'function') return undefined;
  try {
    const session = getter.call(store, sessionId) as
      | { metadata?: { modelOverride?: unknown; modelRef?: { modelId?: unknown } } }
      | undefined;
    const override = session?.metadata?.modelOverride;
    const overrideId =
      typeof override === 'string' ? override : (override as { modelId?: unknown } | undefined)?.modelId;
    return namedModel(overrideId, session?.metadata?.modelRef?.modelId);
  } catch {
    return undefined;
  }
}

function usageOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const usageRaw = payload.usage;
  if (!usageRaw || typeof usageRaw !== 'object' || Array.isArray(usageRaw)) return undefined;
  const u = usageRaw as Record<string, unknown>;
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : undefined;
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : undefined;
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
  if (input == null && output == null && total == null) return undefined;
  return { input, output, total, unit: 'TOKENS' };
}

function usageDetailsOf(usage: Record<string, unknown>): Record<string, number> {
  const details: Record<string, number> = {};
  if (typeof usage.input === 'number') details.input = usage.input;
  if (typeof usage.output === 'number') details.output = usage.output;
  if (typeof usage.total === 'number') details.total = usage.total;
  return details;
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function envelope(
  type: string,
  body: Record<string, unknown>,
  timestamp = nowIso()
): LangfuseBatchEvent {
  return {
    id: randomUUID(),
    type,
    timestamp,
    body
  };
}

export function buildLangfuseBatch(
  sessionId: string,
  event: { kind?: string; payload?: unknown; data?: unknown; [k: string]: unknown },
  opts?: { model?: string }
): LangfuseBatchEvent[] {
  const traceId = stableLangfuseTraceId(sessionId);
  const ts = nowIso();
  const kind = typeof event.kind === 'string' && event.kind ? event.kind : 'event';
  const payload = eventPayload(event);
  const state = openSession(sessionId);
  const explicitModel = namedModel(payload.model, payload.costModel, opts?.model);
  if (explicitModel) state.model = explicitModel;
  const model = state.model ?? undefined;
  const batch: LangfuseBatchEvent[] = [
    envelope(
      'trace-create',
      {
        id: traceId,
        name: model ?? 'session',
        sessionId,
        metadata: {
          source: 'ppeng-agent-core',
          ...(model ? { model } : {})
        }
      },
      ts
    )
  ];

  if (kind === 'turn_start') {
    const turn = typeof payload.turn === 'number' ? payload.turn : (state.turn ?? -1) + 1;
    const reuse = state.turnSpanId != null && state.genId == null;
    if (state.turnSpanId && !reuse) {
      batch.push(
        envelope(
          'span-update',
          { id: state.turnSpanId, traceId, endTime: endAfter(state.turnStartedAt, ts) },
          ts
        )
      );
      state.turnSpanId = null;
      state.genId = null;
      state.tools = [];
    }
    const modelName = model ?? 'model';
    const genId = randomUUID();
    if (!state.turnSpanId) {
      const turnSpanId = randomUUID();
      state.turnSpanId = turnSpanId;
      state.turnStartedAt = ts;
      batch.push(
        envelope(
          'span-create',
          {
            id: turnSpanId,
            traceId,
            name: `turn ${turn}`,
            startTime: ts,
            metadata: { turn }
          },
          ts
        )
      );
    } else {
      batch.push(
        envelope(
          'span-update',
          { id: state.turnSpanId, traceId, name: `turn ${turn}`, metadata: { turn } },
          ts
        )
      );
    }
    state.turn = turn;
    state.genId = genId;
    state.genStartedAt = ts;
    batch.push(
      envelope(
        'generation-create',
        {
          id: genId,
          traceId,
          parentObservationId: state.turnSpanId,
          name: modelName,
          model: modelName,
          startTime: ts,
          metadata: { turn }
        },
        ts
      )
    );
    return batch;
  }

  if (kind === 'jev_call') {
    const point = typeof payload.point === 'string' && payload.point ? payload.point : 'jev';
    const start = typeof payload.startedAt === 'string' ? payload.startedAt : ts;
    const end = endAfter(start, typeof payload.endedAt === 'string' ? payload.endedAt : ts);
    if (!state.turnSpanId) {
      const turnSpanId = randomUUID();
      state.turnSpanId = turnSpanId;
      state.turnStartedAt = start;
      batch.push(
        envelope(
          'span-create',
          {
            id: turnSpanId,
            traceId,
            name: 'turn',
            startTime: start
          },
          start
        )
      );
    }
    batch.push(
      envelope(
        'span-create',
        {
          id: randomUUID(),
          traceId,
          parentObservationId: state.turnSpanId,
          name: `jev.${point}`,
          startTime: start,
          endTime: end,
          input: truncateJson(payload.questions),
          output: truncateJson(payload.ok === false ? { error: payload.error } : payload.answers),
          metadata: truncateJson({
            point,
            durationMs: payload.durationMs,
            ok: payload.ok,
            error: payload.error
          }),
          level: payload.ok === false ? 'ERROR' : 'DEFAULT'
        },
        end
      )
    );
    return batch;
  }

  if (kind === 'turn_end' && payload.terminal === true) {
    if (state.turnSpanId) {
      batch.push(
        envelope(
          'span-update',
          { id: state.turnSpanId, traceId, endTime: endAfter(state.turnStartedAt, ts) },
          ts
        )
      );
    }
    state.turnSpanId = null;
    state.turnStartedAt = null;
    state.genId = null;
    state.genStartedAt = null;
    state.tools = [];
    openSessions.delete(sessionId);
    batch[0] = envelope(
      'trace-create',
      {
        id: traceId,
        name: model ?? 'session',
        sessionId,
        output: truncateJson({ reason: payload.reason, outcome: payload.outcome }),
        metadata: { source: 'ppeng-agent-core', ...(model ? { model } : {}) }
      },
      ts
    );
    return batch;
  }

  if (kind === 'turn_end') {
    const usage = usageOf(payload);
    const modelName = model ?? 'model';
    const output = truncateJson({
      stopReason: payload.stopReason,
      finishReason: payload.finishReason,
      requestId: payload.requestId
    });
    if (!state.turnSpanId || !state.genId) {
      const turnSpanId = randomUUID();
      const genId = randomUUID();
      state.turnSpanId = turnSpanId;
      state.turnStartedAt = ts;
      state.genId = genId;
      state.genStartedAt = ts;
      const end = plusMs(ts, 1);
      batch.push(
        envelope(
          'span-create',
          {
            id: turnSpanId,
            traceId,
            name: `turn ${state.turn ?? 0}`,
            startTime: ts,
            endTime: end
          },
          ts
        )
      );
      const body: Record<string, unknown> = {
        id: genId,
        traceId,
        parentObservationId: turnSpanId,
        name: modelName,
        model: modelName,
        startTime: ts,
        endTime: end,
        output
      };
      if (usage) {
        body.usage = usage;
        body.usageDetails = usageDetailsOf(usage);
      }
      batch.push(envelope('generation-create', body, ts));
      return batch;
    }
    const body: Record<string, unknown> = {
      id: state.genId,
      traceId,
      name: modelName,
      model: modelName,
      endTime: endAfter(state.genStartedAt, ts),
      output
    };
    if (usage) {
      body.usage = usage;
      body.usageDetails = usageDetailsOf(usage);
    }
    if (typeof payload.costUsd === 'number') body.metadata = { costUsd: payload.costUsd };
    batch.push(envelope('generation-update', body, ts));
    return batch;
  }

  if (kind === 'tool_start' || kind === 'tool_end') {
    const toolName = typeof payload.name === 'string' && payload.name ? payload.name : 'tool';
    if (kind === 'tool_start') {
      const id = randomUUID();
      state.tools.push({ id, name: toolName, startedAt: ts });
      const body: Record<string, unknown> = {
        id,
        traceId,
        name: `tool.${toolName}`,
        startTime: ts,
        metadata: { name: toolName }
      };
      if (state.turnSpanId) body.parentObservationId = state.turnSpanId;
      batch.push(envelope('span-create', body, ts));
      return batch;
    }
    const idxFromEnd = [...state.tools].reverse().findIndex((tool) => tool.name === toolName);
    const idx = idxFromEnd === -1 ? -1 : state.tools.length - 1 - idxFromEnd;
    const metadata: Record<string, unknown> = { name: toolName };
    if ('ok' in payload) metadata.ok = payload.ok;
    if (idx >= 0) {
      const open = state.tools.splice(idx, 1)[0]!;
      batch.push(
        envelope(
          'span-update',
          {
            id: open.id,
            traceId,
            endTime: endAfter(open.startedAt, ts),
            metadata,
            output: truncateJson({ ok: payload.ok }),
            level: payload.ok === false ? 'ERROR' : 'DEFAULT'
          },
          ts
        )
      );
      return batch;
    }
    const end = plusMs(ts, 1);
    const body: Record<string, unknown> = {
      id: randomUUID(),
      traceId,
      name: `tool.${toolName}`,
      startTime: ts,
      endTime: end,
      metadata,
      level: payload.ok === false ? 'ERROR' : 'DEFAULT'
    };
    if (state.turnSpanId) body.parentObservationId = state.turnSpanId;
    batch.push(envelope('span-create', body, ts));
    return batch;
  }

  const level = ERROR_KINDS.has(kind) ? 'ERROR' : 'DEFAULT';
  const body: Record<string, unknown> = {
    id: randomUUID(),
    traceId,
    name: kind,
    startTime: ts,
    endTime: plusMs(ts, 1),
    metadata: truncateJson(payload),
    level
  };
  if (state.turnSpanId) body.parentObservationId = state.turnSpanId;
  batch.push(envelope('span-create', body, ts));
  return batch;
}

async function postIngestion(
  chain: LangfuseChain,
  batch: LangfuseBatchEvent[],
  fetchImpl: LangfuseFetch
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = langfuseIngestionUrl(chain.baseUrl);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(chain.publicKey, chain.secretKey),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch })
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: true, status: res.status };
    }
    if (
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { errors?: unknown }).errors) &&
      ((body as { errors: unknown[] }).errors.length > 0)
    ) {
      return { ok: false, status: res.status, error: 'ingestion errors' };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Fire-and-forget mirror. Swallows all errors. No-op when not chained.
 */
export async function mirrorTraceToLangfuse(
  store: LangfuseSettingsStore,
  sessionId: string,
  event: { kind?: string; payload?: unknown; data?: unknown; [k: string]: unknown },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: LangfuseFetch = fetch as LangfuseFetch
): Promise<void> {
  try {
    const chain = resolveLangfuseChain(store, env);
    if (!chain) return;
    const hinted = modelFromStore(store, sessionId);
    const batch = buildLangfuseBatch(sessionId, event, hinted ? { model: hinted } : undefined);
    await postIngestion(chain, batch, fetchImpl);
  } catch {
    // fail-open
  }
}

/** Connectivity probe; does not write KV or toggle enabled. */
export async function probeLangfuse(
  chain: Pick<LangfuseChain, 'baseUrl' | 'publicKey' | 'secretKey'>,
  fetchImpl: LangfuseFetch = fetch as LangfuseFetch
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    if (!chain.baseUrl.trim()) {
      return { ok: false, error: 'baseUrl required' };
    }
    if (!chain.publicKey || !chain.secretKey) {
      return { ok: false, error: 'publicKey and secretKey required' };
    }
    const ts = nowIso();
    const batch = [
      envelope(
        'trace-create',
        {
          id: randomUUID(),
          name: 'ppeng-langfuse-probe',
          metadata: { source: 'ppeng-agent-core', probe: true }
        },
        ts
      )
    ];
    return await postIngestion(
      {
        baseUrl: chain.baseUrl.trim().replace(/\/+$/, ''),
        publicKey: chain.publicKey,
        secretKey: chain.secretKey
      },
      batch,
      fetchImpl
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

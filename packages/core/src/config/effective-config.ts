/**
 * 「按配置推导有效值」的唯一入口。
 *
 * 原则：配了就启用，没配就本地兜底，永不因「没配」而启动失败或功能半残。
 *
 * 优先级（高 → 低）：
 *   1. 显式值    env 里明确写了开关/模式（`RAW_AGENT_*_PROVIDER`、`RAW_AGENT_DOMAINS` CSV、
 *                `RAW_AGENT_GATEWAY_ENABLED`…）。含 `0` / `off` / `local` / `sqlite`，一律尊重。
 *   2. Lab 持久化  `daemon_control` KV（web 搜索模板、记忆向量召回模式、浏览器…）。
 *   3. env 连接信息  `DATABASE_URL` / `REDIS_URL` / `RAW_AGENT_S3_*` / `RAW_AGENT_WEB_SEARCH_URL` / `SRE_*` …
 *   4. 自动推断  只有「用户提供了连接信息/凭证/端点」才算配了；PATH 上有二进制不算。
 *   5. 本地兜底  SQLite / 本地盘 / 进程内锁 / 工具不暴露。
 *
 * 配了一半（例如只配了 S3 endpoint 缺 key）：回退本地并给出 warning，不 throw。
 * 只有「显式强制了某个云档，却缺依赖」才算硬错误（`missingForced`）。
 */

import { parseMcpHttpConfig } from '../mcp/mcp-http-config.js';
import type {
  AssetStorageProvider,
  DeploymentMode,
  DispatchLockProvider,
  EventBufferProvider,
  ProviderConfig,
  SessionStoreProvider,
  SkillRegistryProvider
} from '../storage/provider-config.js';

export type ConfigSource = 'explicit-env' | 'lab' | 'auto-detected' | 'local-fallback';
export type ConfigGroup = 'storage' | 'capability' | 'manual';

/** 可翻译的提示：UI 用 `code` 查 i18n，`message` 是英文兜底。 */
export interface ConfigNote {
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

export interface EffectiveItem {
  id: string;
  group: ConfigGroup;
  enabled: boolean;
  /** 当前生效的具体档位，如 sqlite / local / redis_postgres / tiered / sre,stock。 */
  mode: string;
  source: ConfigSource;
  reasonCode: string;
  reason: string;
  params?: Record<string, string | number>;
  warnings: ConfigNote[];
  hints: ConfigNote[];
}

export type StorageFeature = 'sessionStore' | 'eventBuffer' | 'skillRegistry' | 'assetStorage' | 'dispatchLock';

export type MemoryEmbeddingMode = 'auto' | 'on' | 'off';

export interface EffectiveConfigInput {
  env: NodeJS.ProcessEnv;
  /** 仅用于推导 tiered 资产缓存目录默认值。 */
  stateDir?: string;
  lab?: {
    webSearch?: { persisted: boolean; template: string };
    memory?: { persisted: boolean; embeddingRecallMode: MemoryEmbeddingMode };
    browser?: { persisted: boolean; enabled: boolean };
    discovery?: { persisted: boolean; enabled: boolean };
    /** Lab 模型供应商里是否已有可用的 openai-compatible（含 key + baseUrl）。 */
    openAiCompatibleProviderConfigured?: boolean;
  };
  probes?: {
    gatewayConfigExists?: boolean;
    /** PATH 上检测到的外部 AI CLI（仅作提示，不自动开启）。 */
    localBinaries?: string[];
  };
  runtime?: {
    /** 启动探测/运行期失败后回退本地的存储项。 */
    storageFallbacks?: Partial<Record<StorageFeature, ConfigNote>>;
    domainsMounted?: string[];
    /** Live HTTP MCP sessions that finished connect(). */
    mcpHttpConnected?: number;
  };
}

export interface EffectiveConfig {
  generatedAt: string;
  /** local = 全本地；hybrid = 至少一项外部服务生效；cloud = 显式指定。 */
  mode: DeploymentMode;
  summary: {
    externalServices: string[];
    autoEnabled: string[];
    partial: string[];
  };
  items: EffectiveItem[];
  warnings: Array<ConfigNote & { itemId: string }>;
}

export interface StorageResolution {
  config: ProviderConfig;
  items: EffectiveItem[];
  /** 显式强制了云档但缺依赖的 env 名；只有这种情况才应阻止启动。 */
  missingForced: string[];
  /** auto-detected 的 PG 档（启动探测失败时可整体回退）。 */
  autoPostgres: Array<'eventBuffer' | 'skillRegistry'>;
  /** tiered 缓存目录（env 未给时推导）。 */
  tieredCacheDir: string;
}

const S3_REQUIRED_KEYS = [
  'RAW_AGENT_S3_ENDPOINT',
  'RAW_AGENT_S3_BUCKET',
  'RAW_AGENT_S3_ACCESS_KEY',
  'RAW_AGENT_S3_SECRET_KEY'
] as const;

const DEPLOYMENT_MODES = ['local', 'hybrid', 'cloud'] as const;
const SESSION_STORES = ['sqlite', 'postgres'] as const;
const EVENT_BUFFERS = ['local', 'redis_postgres'] as const;
const SKILL_REGISTRIES = ['local_fs', 'pg_redis'] as const;
const ASSET_STORAGES = ['local', 'tiered'] as const;
const DISPATCH_LOCKS = ['local', 'redis'] as const;

export const PG_MIGRATION_HINT = 'packages/core/src/storage/migrations/pg/001_initial.sql';

function has(env: NodeJS.ProcessEnv, key: string): boolean {
  return String(env[key] ?? '').trim() !== '';
}

function val(env: NodeJS.ProcessEnv, key: string): string {
  return String(env[key] ?? '').trim();
}

function note(code: string, message: string, params?: Record<string, string | number>): ConfigNote {
  return params ? { code, message, params } : { code, message };
}

function parseExplicit<T extends string>(
  raw: string | undefined,
  allowed: readonly T[]
): { value?: T; invalid?: string } {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return {};
  if ((allowed as readonly string[]).includes(v)) return { value: v as T };
  return { invalid: v };
}

function item(
  id: string,
  group: ConfigGroup,
  enabled: boolean,
  mode: string,
  source: ConfigSource,
  reasonCode: string,
  reason: string,
  extra: { params?: Record<string, string | number>; warnings?: ConfigNote[]; hints?: ConfigNote[] } = {}
): EffectiveItem {
  return {
    id,
    group,
    enabled,
    mode,
    source,
    reasonCode,
    reason,
    ...(extra.params ? { params: extra.params } : {}),
    warnings: extra.warnings ?? [],
    hints: extra.hints ?? []
  };
}

function invalidProviderWarning(key: string, value: string): ConfigNote {
  return note('invalid_provider_value', `${key}="${value}" is not a recognised value; ignored.`, { key, value });
}

/**
 * 存储档位：env 连接信息 → 自动推断；显式 `RAW_AGENT_*_PROVIDER` 永远优先。
 * 纯函数；不连接任何外部服务。
 */
export function resolveStorage(
  env: NodeJS.ProcessEnv,
  opts: { stateDir?: string; fallbacks?: Partial<Record<StorageFeature, ConfigNote>> } = {}
): StorageResolution {
  const items: EffectiveItem[] = [];
  const missingForced: string[] = [];
  const autoPostgres: Array<'eventBuffer' | 'skillRegistry'> = [];
  const fallbacks = opts.fallbacks ?? {};

  const hasPg = has(env, 'DATABASE_URL');
  const hasRedis = has(env, 'REDIS_URL');
  const missingS3 = S3_REQUIRED_KEYS.filter((k) => !has(env, k));
  const anyS3 = S3_REQUIRED_KEYS.some((k) => has(env, k));
  const s3Complete = missingS3.length === 0;

  const forcedNeeds = (keys: string[]): string[] => keys.filter((k) => !has(env, k));

  const runtimeFallbackItem = (
    id: StorageFeature,
    localMode: string,
    base: EffectiveItem
  ): EffectiveItem => {
    const fb = fallbacks[id];
    if (!fb) return base;
    return item(
      `storage.${id}`,
      'storage',
      false,
      localMode,
      'local-fallback',
      'runtime_fallback',
      'Configured external service is unavailable; running in local mode.',
      { warnings: [fb], hints: base.hints }
    );
  };

  // ── eventBuffer ────────────────────────────────────────────────────────────
  let eventBuffer: EventBufferProvider = 'local';
  {
    const p = parseExplicit(env.RAW_AGENT_EVENT_BUFFER_PROVIDER, EVENT_BUFFERS);
    const warnings: ConfigNote[] = [];
    if (p.invalid) warnings.push(invalidProviderWarning('RAW_AGENT_EVENT_BUFFER_PROVIDER', p.invalid));
    let it: EffectiveItem;
    if (p.value) {
      eventBuffer = p.value;
      if (p.value === 'redis_postgres') {
        missingForced.push(...forcedNeeds(['DATABASE_URL']));
        it = item('storage.eventBuffer', 'storage', true, p.value, 'explicit-env', 'explicit_provider',
          'Forced by RAW_AGENT_EVENT_BUFFER_PROVIDER.', { warnings });
      } else {
        it = item('storage.eventBuffer', 'storage', false, p.value, 'explicit-env', 'explicit_local',
          'Explicitly set to local by RAW_AGENT_EVENT_BUFFER_PROVIDER.', { warnings });
      }
    } else if (hasPg) {
      eventBuffer = 'redis_postgres';
      autoPostgres.push('eventBuffer');
      const hints = hasRedis ? [] : [note('redis_optional_missing', 'REDIS_URL is not set; the Redis meta cache is skipped (PostgreSQL still works).')];
      it = item('storage.eventBuffer', 'storage', true, 'redis_postgres', 'auto-detected', 'database_url_set',
        'DATABASE_URL is set.', { warnings, hints });
    } else {
      it = item('storage.eventBuffer', 'storage', false, 'local', 'local-fallback', 'not_configured',
        'DATABASE_URL is not set; using the local event buffer.', { warnings });
    }
    items.push(runtimeFallbackItem('eventBuffer', 'local', it));
  }

  // ── skillRegistry ──────────────────────────────────────────────────────────
  let skillRegistry: SkillRegistryProvider = 'local_fs';
  {
    const p = parseExplicit(env.RAW_AGENT_SKILL_REGISTRY_PROVIDER, SKILL_REGISTRIES);
    const warnings: ConfigNote[] = [];
    if (p.invalid) warnings.push(invalidProviderWarning('RAW_AGENT_SKILL_REGISTRY_PROVIDER', p.invalid));
    let it: EffectiveItem;
    if (p.value) {
      skillRegistry = p.value;
      if (p.value === 'pg_redis') {
        missingForced.push(...forcedNeeds(['DATABASE_URL']));
        it = item('storage.skillRegistry', 'storage', true, p.value, 'explicit-env', 'explicit_provider',
          'Forced by RAW_AGENT_SKILL_REGISTRY_PROVIDER.', { warnings });
      } else {
        it = item('storage.skillRegistry', 'storage', false, p.value, 'explicit-env', 'explicit_local',
          'Explicitly set to local by RAW_AGENT_SKILL_REGISTRY_PROVIDER.', { warnings });
      }
    } else if (hasPg) {
      skillRegistry = 'pg_redis';
      autoPostgres.push('skillRegistry');
      const hints = hasRedis ? [] : [note('redis_optional_missing', 'REDIS_URL is not set; the Redis catalog cache is skipped (PostgreSQL still works).')];
      it = item('storage.skillRegistry', 'storage', true, 'pg_redis', 'auto-detected', 'database_url_set',
        'DATABASE_URL is set.', { warnings, hints });
    } else {
      it = item('storage.skillRegistry', 'storage', false, 'local_fs', 'local-fallback', 'not_configured',
        'DATABASE_URL is not set; using local skill files.', { warnings });
    }
    items.push(runtimeFallbackItem('skillRegistry', 'local_fs', it));
  }

  // ── assetStorage ───────────────────────────────────────────────────────────
  let assetStorage: AssetStorageProvider = 'local';
  {
    const p = parseExplicit(env.RAW_AGENT_ASSET_STORAGE_PROVIDER, ASSET_STORAGES);
    const warnings: ConfigNote[] = [];
    if (p.invalid) warnings.push(invalidProviderWarning('RAW_AGENT_ASSET_STORAGE_PROVIDER', p.invalid));
    let it: EffectiveItem;
    if (p.value) {
      assetStorage = p.value;
      if (p.value === 'tiered') {
        missingForced.push(...forcedNeeds([...S3_REQUIRED_KEYS]));
        const hints = hasRedis ? [] : [note('redis_optional_missing', 'REDIS_URL is not set; the Redis LRU scoreboard is skipped (S3 + local cache still work).')];
        it = item('storage.assetStorage', 'storage', true, p.value, 'explicit-env', 'explicit_provider',
          'Forced by RAW_AGENT_ASSET_STORAGE_PROVIDER.', { warnings, hints });
      } else {
        it = item('storage.assetStorage', 'storage', false, p.value, 'explicit-env', 'explicit_local',
          'Explicitly set to local by RAW_AGENT_ASSET_STORAGE_PROVIDER.', { warnings });
      }
    } else if (s3Complete) {
      assetStorage = 'tiered';
      const hints = hasRedis ? [] : [note('redis_optional_missing', 'REDIS_URL is not set; the Redis LRU scoreboard is skipped (S3 + local cache still work).')];
      it = item('storage.assetStorage', 'storage', true, 'tiered', 'auto-detected', 's3_complete',
        'RAW_AGENT_S3_* is fully configured.', { warnings, hints });
    } else if (anyS3) {
      warnings.push(
        note(
          'partial_s3',
          `S3 is only partly configured (missing ${missingS3.join(', ')}); using local assets. Set the missing keys to enable tiered storage.`,
          { missing: missingS3.join(', ') }
        )
      );
      it = item('storage.assetStorage', 'storage', false, 'local', 'local-fallback', 'partial_config',
        'S3 configuration is incomplete; using local assets.', { warnings });
    } else {
      it = item('storage.assetStorage', 'storage', false, 'local', 'local-fallback', 'not_configured',
        'RAW_AGENT_S3_* is not set; using local assets.', { warnings });
    }
    items.push(runtimeFallbackItem('assetStorage', 'local', it));
  }

  // ── dispatchLock ───────────────────────────────────────────────────────────
  let dispatchLock: DispatchLockProvider = 'local';
  {
    const p = parseExplicit(env.RAW_AGENT_DISPATCH_LOCK_PROVIDER, DISPATCH_LOCKS);
    const warnings: ConfigNote[] = [];
    if (p.invalid) warnings.push(invalidProviderWarning('RAW_AGENT_DISPATCH_LOCK_PROVIDER', p.invalid));
    let it: EffectiveItem;
    if (p.value) {
      dispatchLock = p.value;
      if (p.value === 'redis') {
        missingForced.push(...forcedNeeds(['REDIS_URL']));
        it = item('storage.dispatchLock', 'storage', true, p.value, 'explicit-env', 'explicit_provider',
          'Forced by RAW_AGENT_DISPATCH_LOCK_PROVIDER.', { warnings });
      } else {
        it = item('storage.dispatchLock', 'storage', false, p.value, 'explicit-env', 'explicit_local',
          'Explicitly set to local by RAW_AGENT_DISPATCH_LOCK_PROVIDER.', { warnings });
      }
    } else if (hasRedis) {
      dispatchLock = 'redis';
      it = item('storage.dispatchLock', 'storage', true, 'redis', 'auto-detected', 'redis_url_set',
        'REDIS_URL is set.', { warnings });
    } else {
      it = item('storage.dispatchLock', 'storage', false, 'local', 'local-fallback', 'not_configured',
        'REDIS_URL is not set; using the in-process scheduler lock.', { warnings });
    }
    items.push(runtimeFallbackItem('dispatchLock', 'local', it));
  }

  // ── sessionStore（运行时仍是 SQLite）──────────────────────────────────────────
  let sessionStore: SessionStoreProvider = 'sqlite';
  {
    const p = parseExplicit(env.RAW_AGENT_SESSION_STORE_PROVIDER, SESSION_STORES);
    const warnings: ConfigNote[] = [];
    const hints: ConfigNote[] = [];
    if (p.invalid) warnings.push(invalidProviderWarning('RAW_AGENT_SESSION_STORE_PROVIDER', p.invalid));
    let it: EffectiveItem;
    if (p.value === 'postgres') {
      sessionStore = 'postgres';
      missingForced.push(...forcedNeeds(['DATABASE_URL']));
      warnings.push(
        note('session_postgres_not_migrated', 'Session store migration to PostgreSQL is not finished; sessions still live in SQLite.')
      );
      it = item('storage.sessionStore', 'storage', false, 'sqlite', 'explicit-env', 'explicit_provider_unmigrated',
        'RAW_AGENT_SESSION_STORE_PROVIDER=postgres was requested, but the runtime still uses SQLite.', { warnings });
    } else if (p.value === 'sqlite') {
      it = item('storage.sessionStore', 'storage', false, 'sqlite', 'explicit-env', 'explicit_local',
        'Explicitly set to SQLite by RAW_AGENT_SESSION_STORE_PROVIDER.', { warnings });
    } else {
      if (hasPg) {
        hints.push(note('session_still_sqlite', 'DATABASE_URL does not move sessions to PostgreSQL yet; sessions stay in SQLite.'));
      }
      it = item('storage.sessionStore', 'storage', false, 'sqlite', 'local-fallback', 'sqlite_only',
        'Sessions are stored in local SQLite.', { warnings, hints });
    }
    items.push(it);
  }

  if (fallbacks.eventBuffer) eventBuffer = 'local';
  if (fallbacks.skillRegistry) skillRegistry = 'local_fs';
  if (fallbacks.assetStorage) assetStorage = 'local';
  if (fallbacks.dispatchLock) dispatchLock = 'local';
  const activeAutoPostgres = autoPostgres.filter((f) => !fallbacks[f]);

  // ── deploymentMode ─────────────────────────────────────────────────────────
  let deploymentMode: DeploymentMode;
  {
    const p = parseExplicit(env.RAW_AGENT_DEPLOYMENT_MODE, DEPLOYMENT_MODES);
    if (p.value) {
      deploymentMode = p.value;
      if (p.value === 'cloud') missingForced.push(...forcedNeeds(['DATABASE_URL']));
    } else {
      const anyExternal =
        eventBuffer !== 'local' || skillRegistry !== 'local_fs' || assetStorage !== 'local' || dispatchLock !== 'local';
      deploymentMode = anyExternal ? 'hybrid' : 'local';
    }
  }

  const tieredCacheDir =
    val(env, 'RAW_AGENT_TIERED_CACHE_DIR') ||
    `${(opts.stateDir ?? '.agent-state').replace(/[\\/]+$/, '')}/tiered-cache`;

  return {
    config: { deploymentMode, sessionStore, eventBuffer, skillRegistry, assetStorage, dispatchLock },
    items,
    missingForced: [...new Set(missingForced)],
    autoPostgres: activeAutoPostgres,
    tieredCacheDir
  };
}

// ── 领域包 ────────────────────────────────────────────────────────────────────

const DOMAIN_AUTO_SIGNALS: Record<string, readonly string[]> = {
  sre: ['SRE_PROM_URL', 'SRE_LOKI_URL', 'SRE_PAGERDUTY_TOKEN', 'SRE_KUBECONFIG'],
  stock: ['STOCK_API_KEY', 'STOCK_NEWS_URL']
};

export interface DomainSelection {
  ids: string[];
  source: ConfigSource;
  /** 自动挂载时，每个 id 命中的连接信息 env 名。 */
  detected: Record<string, string[]>;
}

/**
 * `RAW_AGENT_DOMAINS` 一旦设置（哪怕为空串）即为显式，以它为准；
 * 未设置时，检测到 `SRE_*` / `STOCK_*` 连接信息才自动挂载对应领域包（仅 sre / stock，只读）。
 */
export function resolveDomainSelection(env: NodeJS.ProcessEnv): DomainSelection {
  const raw = env.RAW_AGENT_DOMAINS;
  if (raw !== undefined) {
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { ids: [...new Set(ids)], source: 'explicit-env', detected: {} };
  }
  const ids: string[] = [];
  const detected: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(DOMAIN_AUTO_SIGNALS)) {
    const hit = keys.filter((k) => has(env, k));
    if (hit.length > 0) {
      ids.push(id);
      detected[id] = hit;
    }
  }
  return { ids, source: ids.length > 0 ? 'auto-detected' : 'local-fallback', detected };
}

// ── 记忆向量召回 ──────────────────────────────────────────────────────────────

export function parseMemoryEmbeddingMode(raw: unknown): MemoryEmbeddingMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return v === 'auto' || v === 'on' || v === 'off' ? v : undefined;
}

/** 解析 embeddings 上游：专用 env 优先，其次复用对话 base/key。 */
export function embeddingUpstream(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey: string; dedicated: boolean } {
  const baseUrl = (env.RAW_AGENT_EMBEDDING_BASE_URL ?? env.RAW_AGENT_BASE_URL ?? '').trim();
  const apiKey = (env.RAW_AGENT_EMBEDDING_API_KEY ?? env.RAW_AGENT_API_KEY ?? '').trim();
  const dedicated =
    has(env, 'RAW_AGENT_EMBEDDING_API_KEY') ||
    has(env, 'RAW_AGENT_EMBEDDING_BASE_URL') ||
    has(env, 'RAW_AGENT_EMBEDDING_MODEL');
  return { baseUrl, apiKey, dedicated };
}

/**
 * 向量召回是否生效。
 *   off  → 否（显式关，含 Lab 里关）
 *   on   → 有可用 key 即是（复用对话 key 也行）
 *   auto → 仅当配了专用 embedding 配置（`RAW_AGENT_EMBEDDING_*`）且 base/key 齐全；
 *          仅有对话 key 不自动开（第三方网关常无 /embeddings，每次召回白白多一次失败请求）。
 */
export function resolveEmbeddingRecall(
  env: NodeJS.ProcessEnv,
  mode: MemoryEmbeddingMode
): { enabled: boolean; reasonCode: string } {
  if (mode === 'off') return { enabled: false, reasonCode: 'lab_off' };
  const up = embeddingUpstream(env);
  const usable = Boolean(up.baseUrl && up.apiKey);
  if (mode === 'on') return usable ? { enabled: true, reasonCode: 'lab_on' } : { enabled: false, reasonCode: 'lab_on_no_key' };
  if (up.dedicated && usable) return { enabled: true, reasonCode: 'embedding_env_set' };
  if (up.dedicated) return { enabled: false, reasonCode: 'embedding_partial' };
  return { enabled: false, reasonCode: 'not_configured' };
}

// ── 聚合 ──────────────────────────────────────────────────────────────────────

function resolveWebSearch(input: EffectiveConfigInput): EffectiveItem {
  const lab = input.lab?.webSearch;
  const envTemplate = val(input.env, 'RAW_AGENT_WEB_SEARCH_URL');
  const checkTemplate = (tpl: string): ConfigNote[] =>
    tpl.includes('{query}')
      ? []
      : [note('web_search_missing_query', 'The search URL template must contain {query}.')];
  if (lab?.persisted) {
    const tpl = lab.template.trim();
    if (tpl) {
      return item('capability.webSearch', 'capability', true, 'url_template', 'lab', 'lab_template',
        'A search URL template is saved in Lab.', { warnings: checkTemplate(tpl) });
    }
    return item('capability.webSearch', 'capability', false, 'off', 'lab', 'lab_cleared',
      'The search URL template was cleared in Lab.');
  }
  if (envTemplate) {
    return item('capability.webSearch', 'capability', true, 'url_template', 'auto-detected', 'env_template',
      'RAW_AGENT_WEB_SEARCH_URL is set.', { warnings: checkTemplate(envTemplate) });
  }
  return item('capability.webSearch', 'capability', false, 'off', 'local-fallback', 'not_configured',
    'No search URL template; web_search is not exposed.');
}

/** 与 `mcp/mcp-stdio.ts#parseMcpStdioConfigs` 同口径：JSON 数组里带 command 的项才算。 */
function countMcpStdio(env: NodeJS.ProcessEnv): number {
  const raw = val(env, 'RAW_AGENT_MCP_STDIO');
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return 0;
    return parsed.filter((o) => typeof (o as { command?: unknown })?.command === 'string' && (o as { command: string }).command).length;
  } catch {
    return 0;
  }
}

function resolveMcp(input: EffectiveConfigInput): EffectiveItem {
  const env = input.env;
  const httpConfig = parseMcpHttpConfig(env);
  const httpCount = httpConfig.endpoints.length;
  const stdioRaw = val(env, 'RAW_AGENT_MCP_STDIO');
  const stdioCount = countMcpStdio(env);
  const warnings: ConfigNote[] = [];
  if (stdioRaw && stdioCount === 0) {
    warnings.push(note('mcp_stdio_invalid', 'RAW_AGENT_MCP_STDIO is set but has no valid {command} entries.'));
  }
  if (httpConfig.invalidJson) {
    warnings.push(note('mcp_http_invalid', 'RAW_AGENT_MCP_HTTP is set but is not a JSON array of url entries.'));
  }
  const connected = input.runtime?.mcpHttpConnected ?? 0;
  const count = httpCount + stdioCount;
  if (connected > 0) {
    return item('capability.mcp', 'capability', true, 'mcp', 'auto-detected', 'mcp_connected',
      'HTTP MCP servers are connected.', {
        params: { connected, http: httpCount, stdio: stdioCount },
        warnings
      });
  }
  if (count > 0) {
    return item('capability.mcp', 'capability', true, 'mcp', 'auto-detected', 'mcp_configured',
      'MCP servers are configured.', { params: { http: httpCount, stdio: stdioCount }, warnings });
  }
  return item('capability.mcp', 'capability', false, 'off', 'local-fallback',
    warnings.length ? 'partial_config' : 'not_configured', 'No MCP servers configured.', { warnings });
}

function resolveVision(input: EffectiveConfigInput): EffectiveItem {
  const env = input.env;
  const vlModel = val(env, 'RAW_AGENT_VL_MODEL_NAME');
  if (!vlModel) {
    return item('capability.vision', 'capability', false, 'off', 'local-fallback', 'not_configured',
      'No VL model configured; image turns use the main model.');
  }
  const base = val(env, 'RAW_AGENT_VL_BASE_URL') || val(env, 'RAW_AGENT_BASE_URL');
  const key = val(env, 'RAW_AGENT_VL_API_KEY') || val(env, 'RAW_AGENT_API_KEY');
  if ((base && key) || input.lab?.openAiCompatibleProviderConfigured) {
    return item('capability.vision', 'capability', true, 'hybrid-router', 'auto-detected', 'vl_configured',
      'RAW_AGENT_VL_MODEL_NAME is set; image turns are routed to the VL model.', { params: { model: vlModel } });
  }
  return item('capability.vision', 'capability', false, 'off', 'local-fallback', 'partial_config',
    'The VL model has no endpoint/key; image turns use the main model.', {
      params: { model: vlModel },
      warnings: [
        note('vl_missing_endpoint', 'RAW_AGENT_VL_MODEL_NAME is set but no base URL / API key is available (RAW_AGENT_VL_BASE_URL / RAW_AGENT_VL_API_KEY or the main model credentials).')
      ]
    });
}

function resolveEmbedding(input: EffectiveConfigInput): EffectiveItem {
  const mem = input.lab?.memory;
  const mode: MemoryEmbeddingMode = mem?.embeddingRecallMode ?? 'auto';
  const res = resolveEmbeddingRecall(input.env, mode);
  const explicit = mode !== 'auto';
  const warnings: ConfigNote[] = [];
  const hints: ConfigNote[] = [];
  if (res.reasonCode === 'lab_on_no_key') {
    warnings.push(note('embedding_no_key', 'Embedding recall is on but no base URL / API key is available; recall falls back to FTS.'));
  }
  if (res.reasonCode === 'embedding_partial') {
    warnings.push(note('embedding_partial', 'RAW_AGENT_EMBEDDING_* is only partly configured (needs a base URL and an API key, or the main model credentials); recall stays lexical.'));
  }
  if (!res.enabled && mode === 'auto' && res.reasonCode === 'not_configured') {
    const up = embeddingUpstream(input.env);
    if (up.baseUrl && up.apiKey) {
      hints.push(note('embedding_can_reuse_chat_key', 'The main model key can be reused for embeddings: choose "on" in Memory settings.'));
    }
  }
  if (res.enabled) {
    return item('capability.embeddingRecall', 'capability', true, 'embedding+fts', explicit ? 'lab' : 'auto-detected',
      res.reasonCode, explicit ? 'Embedding recall is turned on in Lab.' : 'An embedding model is configured.', { warnings, hints });
  }
  return item('capability.embeddingRecall', 'capability', false, 'fts', explicit ? 'lab' : 'local-fallback',
    res.reasonCode, explicit ? 'Embedding recall is turned off in Lab; using lexical FTS.' : 'No embedding model configured; using lexical FTS.', { warnings, hints });
}

function resolveDomains(input: EffectiveConfigInput): EffectiveItem {
  const sel = resolveDomainSelection(input.env);
  const mounted = input.runtime?.domainsMounted ?? sel.ids;
  if (sel.source === 'explicit-env') {
    return item('capability.domains', 'capability', mounted.length > 0, mounted.join(',') || 'none', 'explicit-env',
      'explicit_domains', 'RAW_AGENT_DOMAINS is set and takes precedence.', { params: { ids: mounted.join(',') } });
  }
  if (sel.ids.length > 0) {
    const detail = Object.entries(sel.detected).map(([id, keys]) => `${id}: ${keys.join(', ')}`).join('; ');
    return item('capability.domains', 'capability', true, mounted.join(','), 'auto-detected', 'domain_credentials',
      'Domain connection settings were found.', { params: { ids: mounted.join(','), detail } });
  }
  return item('capability.domains', 'capability', false, 'none', 'local-fallback', 'not_configured',
    'No domain connection settings; no domain pack is mounted.');
}

function resolveGateway(input: EffectiveConfigInput): EffectiveItem {
  const raw = val(input.env, 'RAW_AGENT_GATEWAY_ENABLED');
  const enabled = ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  const exists = input.probes?.gatewayConfigExists === true;
  if (raw) {
    const warnings = enabled && !exists
      ? [note('gateway_no_config', 'The gateway is enabled but gateway.config.json was not found.')]
      : [];
    return item('capability.gateway', 'capability', enabled, enabled ? 'gateway' : 'off', 'explicit-env',
      enabled ? 'explicit_on' : 'explicit_off', 'Set by RAW_AGENT_GATEWAY_ENABLED.', { warnings });
  }
  const hints = exists
    ? [note('gateway_config_detected', 'gateway.config.json was found. The gateway opens an inbound HTTP endpoint, so it is never auto-enabled; set RAW_AGENT_GATEWAY_ENABLED=1 to turn it on.')]
    : [];
  return item('capability.gateway', 'capability', false, 'off', 'local-fallback', 'manual_only',
    'The gateway is opt-in (inbound HTTP endpoint).', { hints });
}

function envFlag(env: NodeJS.ProcessEnv, key: string): { set: boolean; on: boolean } {
  const raw = val(env, key).toLowerCase();
  return { set: raw !== '', on: ['1', 'true', 'yes', 'on'].includes(raw) };
}

function resolveManual(input: EffectiveConfigInput): EffectiveItem[] {
  const env = input.env;
  const out: EffectiveItem[] = [];
  const bins = input.probes?.localBinaries ?? [];

  const ext = envFlag(env, 'RAW_AGENT_EXTERNAL_AI_TOOLS');
  out.push(
    item('manual.externalAiTools', 'manual', ext.on, ext.on ? 'on' : 'off', ext.set ? 'explicit-env' : 'local-fallback',
      ext.set ? (ext.on ? 'explicit_on' : 'explicit_off') : 'manual_only',
      'External AI CLIs run local code, so they are opt-in.',
      {
        hints: !ext.on && bins.length > 0
          ? [note('local_binaries_detected', `Detected on this machine: ${bins.join(', ')}. Not enabled automatically.`, { bins: bins.join(', ') })]
          : []
      })
  );

  const browser = input.lab?.browser;
  if (browser?.persisted) {
    out.push(item('manual.browser', 'manual', browser.enabled, browser.enabled ? 'on' : 'off', 'lab', browser.enabled ? 'lab_on' : 'lab_off',
      'Set in Lab.'));
  } else {
    const b = envFlag(env, 'RAW_AGENT_BROWSER_TOOLS');
    out.push(item('manual.browser', 'manual', b.on, b.on ? 'on' : 'off', b.set ? 'explicit-env' : 'local-fallback',
      b.set ? (b.on ? 'explicit_on' : 'explicit_off') : 'manual_only', 'Browser automation is opt-in.'));
  }

  const cron = envFlag(env, 'RAW_AGENT_CRON_TOOLS');
  out.push(item('manual.cron', 'manual', cron.on, cron.on ? 'on' : 'off', cron.set ? 'explicit-env' : 'local-fallback',
    cron.set ? (cron.on ? 'explicit_on' : 'explicit_off') : 'manual_only', 'Scheduled jobs are opt-in.'));

  const a2ui = envFlag(env, 'RAW_AGENT_A2UI_ENABLED');
  out.push(item('manual.a2ui', 'manual', a2ui.on, a2ui.on ? 'on' : 'off', a2ui.set ? 'explicit-env' : 'local-fallback',
    a2ui.set ? (a2ui.on ? 'explicit_on' : 'explicit_off') : 'manual_only', 'A2UI rendering tools are opt-in.'));

  const disc = input.lab?.discovery;
  if (disc?.persisted) {
    out.push(item('manual.discovery', 'manual', disc.enabled, disc.enabled ? 'on' : 'off', 'lab', disc.enabled ? 'lab_on' : 'lab_off',
      'Set in Lab.'));
  } else {
    const d = envFlag(env, 'RAW_AGENT_DISCOVERY');
    out.push(item('manual.discovery', 'manual', d.on, d.on ? 'on' : 'off', d.set ? 'explicit-env' : 'local-fallback',
      d.set ? (d.on ? 'explicit_on' : 'explicit_off') : 'manual_only', 'Capability discovery is opt-in.'));
  }
  return out;
}

export function resolveEffectiveConfig(input: EffectiveConfigInput): EffectiveConfig {
  const storage = resolveStorage(input.env, {
    stateDir: input.stateDir,
    fallbacks: input.runtime?.storageFallbacks
  });
  const items: EffectiveItem[] = [
    ...storage.items,
    resolveWebSearch(input),
    resolveMcp(input),
    resolveVision(input),
    resolveEmbedding(input),
    resolveDomains(input),
    resolveGateway(input),
    ...resolveManual(input)
  ];

  const warnings = items.flatMap((it) => it.warnings.map((w) => ({ ...w, itemId: it.id })));
  const externalServices = items
    .filter((it) => it.group !== 'manual' && it.enabled && it.source !== 'local-fallback')
    .map((it) => it.id);
  const autoEnabled = items.filter((it) => it.enabled && it.source === 'auto-detected').map((it) => it.id);
  const partial = items.filter((it) => it.reasonCode === 'partial_config' || it.reasonCode === 'embedding_partial').map((it) => it.id);

  const anyStorageExternal = storage.items.some((it) => it.enabled);
  const mode: DeploymentMode =
    storage.config.deploymentMode === 'cloud' ? 'cloud' : anyStorageExternal ? 'hybrid' : storage.config.deploymentMode === 'hybrid' ? 'hybrid' : 'local';

  return {
    generatedAt: new Date().toISOString(),
    mode,
    summary: { externalServices, autoEnabled, partial },
    items,
    warnings
  };
}

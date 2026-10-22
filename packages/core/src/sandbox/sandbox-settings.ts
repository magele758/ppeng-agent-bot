/**
 * Sandbox control plane — Lab daemon_control KV first.
 * Env is CI / never-saved fallback. Token stays in SecretVault or process env.
 */

import { nowIso } from '../id.js';
import { getBoundSecretVault, type SecretVault } from '../secrets/secret-vault.js';

export const SANDBOX_SETTINGS_KEY = 'sandbox_settings';

export const SANDBOX_MODES = ['auto', 'direct', 'os', 'container', 'cloudflare-computer'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type CloudflareComputerBackend = '' | 'worker-shell' | 'container-shell';

export interface SandboxSettings {
  mode: SandboxMode;
  /** Worker origin, e.g. https://computer-xxx.workers.dev (no trailing slash). */
  cfEndpoint: string;
  /** Durable Object name → `/c/<name>/`. */
  cfWorkspaceName: string;
  /** Optional human tag. Official HTTP surface does not take an account id. */
  cfAccountId: string;
  cfTimeoutMs: number;
  /**
   * Optional exec backend hint. Official container/worker-shell HTTP examples
   * ignore unknown JSON fields; MCP/custom workers may honor it.
   */
  cfBackend: CloudflareComputerBackend;
  /** SecretVault entry name. Value is never persisted here. */
  cfTokenSecretName: string;
  updatedAt: string;
}

export interface SandboxSettingsPatch {
  mode?: SandboxMode | string;
  cfEndpoint?: string;
  cfWorkspaceName?: string;
  cfAccountId?: string;
  cfTimeoutMs?: number;
  cfBackend?: string;
  cfTokenSecretName?: string;
}

export interface SandboxSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export interface CloudflareComputerResolved {
  endpoint: string;
  workspaceName: string;
  accountId: string;
  timeoutMs: number;
  backend: CloudflareComputerBackend;
  tokenSecretName: string;
  tokenPresent: boolean;
  tokenSource: 'vault' | 'env' | 'none';
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

let boundStore: SandboxSettingsStore | undefined;

export function bindSandboxSettingsStore(store: SandboxSettingsStore | undefined): void {
  boundStore = store;
}

export function getBoundSandboxSettingsStore(): SandboxSettingsStore | undefined {
  return boundStore;
}

export function defaultSandboxSettings(): SandboxSettings {
  return {
    mode: 'auto',
    cfEndpoint: '',
    cfWorkspaceName: 'default',
    cfAccountId: '',
    cfTimeoutMs: DEFAULT_TIMEOUT_MS,
    cfBackend: '',
    cfTokenSecretName: '',
    updatedAt: nowIso()
  };
}

export function parseSandboxMode(raw: unknown): SandboxMode | undefined {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'cf-computer' || v === 'cloudflare-computer') return 'cloudflare-computer';
  if ((SANDBOX_MODES as readonly string[]).includes(v)) return v as SandboxMode;
  return undefined;
}

function clampTimeout(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(raw)));
}

function normalizeEndpoint(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
}

export function normalizeWorkspaceName(raw: unknown, fallback = 'default'): string {
  const v = String(raw ?? '').trim();
  if (WORKSPACE_NAME_RE.test(v)) return v;
  return fallback;
}

function parseBackend(raw: unknown): CloudflareComputerBackend {
  const v = String(raw ?? '').trim();
  if (v === 'worker-shell' || v === 'container-shell') return v;
  return '';
}

export function normalizeSandboxSettings(raw: Partial<SandboxSettings> | null | undefined): SandboxSettings {
  const base = defaultSandboxSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    mode: parseSandboxMode(raw.mode) ?? base.mode,
    cfEndpoint: normalizeEndpoint(raw.cfEndpoint),
    cfWorkspaceName: normalizeWorkspaceName(raw.cfWorkspaceName, base.cfWorkspaceName),
    cfAccountId: typeof raw.cfAccountId === 'string' ? raw.cfAccountId.trim() : '',
    cfTimeoutMs: clampTimeout(raw.cfTimeoutMs, base.cfTimeoutMs),
    cfBackend: parseBackend(raw.cfBackend),
    cfTokenSecretName: typeof raw.cfTokenSecretName === 'string' ? raw.cfTokenSecretName.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function isStore(store: unknown): store is SandboxSettingsStore {
  return (
    !!store &&
    typeof (store as SandboxSettingsStore).getDaemonControl === 'function' &&
    typeof (store as SandboxSettingsStore).setDaemonControl === 'function'
  );
}

export function hasPersistedSandboxSettings(store: SandboxSettingsStore | undefined): boolean {
  return isStore(store) && store.getDaemonControl(SANDBOX_SETTINGS_KEY) != null;
}

export function readSandboxSettings(store: SandboxSettingsStore): SandboxSettings {
  const saved = store.getDaemonControl<Partial<SandboxSettings>>(SANDBOX_SETTINGS_KEY);
  if (!saved) return defaultSandboxSettings();
  return normalizeSandboxSettings(saved);
}

export function writeSandboxSettings(store: SandboxSettingsStore, patch: SandboxSettingsPatch): SandboxSettings {
  const current = readSandboxSettings(store);
  const next = normalizeSandboxSettings({
    ...current,
    cfEndpoint: patch.cfEndpoint ?? current.cfEndpoint,
    cfWorkspaceName: patch.cfWorkspaceName ?? current.cfWorkspaceName,
    cfAccountId: patch.cfAccountId ?? current.cfAccountId,
    cfTimeoutMs: patch.cfTimeoutMs ?? current.cfTimeoutMs,
    cfBackend: patch.cfBackend !== undefined ? parseBackend(patch.cfBackend) : current.cfBackend,
    cfTokenSecretName: patch.cfTokenSecretName ?? current.cfTokenSecretName,
    mode: patch.mode !== undefined ? (parseSandboxMode(patch.mode) ?? current.mode) : current.mode,
    updatedAt: nowIso()
  });
  store.setDaemonControl(SANDBOX_SETTINGS_KEY, next);
  return next;
}

/**
 * Persisted Lab mode wins; otherwise existing RAW_AGENT_SANDBOX_MODE.
 * Shell tools use this effective mode as a constraint. Auto still lets the
 * model choose, and an omitted Auto choice is the strongest isolation available.
 */
export function resolveSandboxMode(
  store: SandboxSettingsStore | undefined,
  env: NodeJS.ProcessEnv = process.env
): SandboxMode {
  if (isStore(store) && hasPersistedSandboxSettings(store)) {
    return readSandboxSettings(store).mode;
  }
  return parseSandboxMode(env.RAW_AGENT_SANDBOX_MODE) ?? 'auto';
}

export function resolveCloudflareComputerConfig(
  store: SandboxSettingsStore | undefined,
  env: NodeJS.ProcessEnv = process.env
): Omit<CloudflareComputerResolved, 'tokenPresent' | 'tokenSource'> {
  const saved = isStore(store) && hasPersistedSandboxSettings(store) ? readSandboxSettings(store) : defaultSandboxSettings();
  const endpoint =
    saved.cfEndpoint ||
    String(env.CLOUDFLARE_COMPUTER_ENDPOINT ?? '').trim().replace(/\/+$/, '');
  return {
    endpoint,
    workspaceName: saved.cfWorkspaceName || 'default',
    accountId: saved.cfAccountId,
    timeoutMs: saved.cfTimeoutMs,
    backend: saved.cfBackend,
    tokenSecretName: saved.cfTokenSecretName
  };
}

export function resolveCloudflareComputerToken(
  cfg: { tokenSecretName: string },
  vault: SecretVault | undefined = getBoundSecretVault(),
  env: NodeJS.ProcessEnv = process.env
): { token?: string; source: CloudflareComputerResolved['tokenSource'] } {
  const named = cfg.tokenSecretName.trim();
  if (named && vault) {
    const fromVault = vault.get(named);
    if (fromVault) return { token: fromVault, source: 'vault' };
  }
  const fromEnv = (env.CLOUDFLARE_COMPUTER_TOKEN ?? env.CF_COMPUTER_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  if (!named && vault) {
    const fallback = vault.get('CLOUDFLARE_COMPUTER_TOKEN');
    if (fallback) return { token: fallback, source: 'vault' };
  }
  return { source: 'none' };
}

export function resolveCloudflareComputer(
  store: SandboxSettingsStore | undefined = getBoundSandboxSettingsStore(),
  env: NodeJS.ProcessEnv = process.env,
  vault?: SecretVault
): CloudflareComputerResolved {
  const cfg = resolveCloudflareComputerConfig(store, env);
  const tok = resolveCloudflareComputerToken(cfg, vault ?? getBoundSecretVault(), env);
  return {
    ...cfg,
    tokenPresent: Boolean(tok.token),
    tokenSource: tok.source
  };
}

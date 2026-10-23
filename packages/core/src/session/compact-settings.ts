/**
 * Tool-result micro-compact Lab settings.
 * Persisted in daemon_control KV. UI / PATCH /api/compact/settings is the
 * control plane — no new RAW_AGENT_* switch for policy.
 *
 * Env still supplies enabled / minChars / hardMaxChars (and keepRecent only
 * when the UI has never saved).
 */

import { nowIso } from '../id.js';
import {
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactConfigFromEnv,
  type MicroCompactConfig,
  type MicroCompactPolicy
} from './micro-compact.js';

export const COMPACT_SETTINGS_KEY = 'compact_settings';

export const COMPACT_POLICIES: readonly MicroCompactPolicy[] = [
  'keep_recent',
  'after_any_assistant',
  'after_text_assistant'
] as const;

export interface CompactSettings {
  policy: MicroCompactPolicy;
  /** Verbatim tool results kept under `keep_recent`. Ignored by after_* policies. */
  keepRecent: number;
  /**
   * Master switch. When set, overrides `RAW_AGENT_MICRO_COMPACT`.
   * Absent means the env flag still decides, so older saves do not change behavior.
   */
  enabled?: boolean;
  updatedAt: string;
}

export interface CompactSettingsPatch {
  policy?: MicroCompactPolicy;
  keepRecent?: number;
  enabled?: boolean;
}

export interface CompactSettingsStore {
  getDaemonControl(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

export function parseCompactPolicy(raw: unknown): MicroCompactPolicy | undefined {
  if (typeof raw !== 'string') return undefined;
  return (COMPACT_POLICIES as readonly string[]).includes(raw)
    ? (raw as MicroCompactPolicy)
    : undefined;
}

export function parseKeepRecent(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 50) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 50) return n;
  }
  return undefined;
}

export function defaultCompactSettings(): CompactSettings {
  return {
    policy: DEFAULT_MICRO_COMPACT_CONFIG.policy ?? 'keep_recent',
    keepRecent: DEFAULT_MICRO_COMPACT_CONFIG.keepRecent,
    updatedAt: nowIso()
  };
}

export function normalizeCompactSettings(
  raw: Partial<CompactSettings> | null | undefined
): CompactSettings {
  const base = defaultCompactSettings();
  if (!raw || typeof raw !== 'object') return base;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  return {
    policy: parseCompactPolicy(raw.policy) ?? base.policy,
    keepRecent: parseKeepRecent(raw.keepRecent) ?? base.keepRecent,
    ...(enabled === undefined ? {} : { enabled }),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function isReadStore(store: unknown): store is CompactSettingsStore {
  return !!store && typeof (store as CompactSettingsStore).getDaemonControl === 'function';
}

export function hasPersistedCompactSettings(
  store: { getDaemonControl?(key: string): unknown } | undefined
): boolean {
  if (!isReadStore(store)) return false;
  return store.getDaemonControl(COMPACT_SETTINGS_KEY) != null;
}

export function readCompactSettings(store: CompactSettingsStore): CompactSettings {
  const saved = store.getDaemonControl(COMPACT_SETTINGS_KEY);
  if (!saved) return defaultCompactSettings();
  return normalizeCompactSettings(saved as Partial<CompactSettings>);
}

export function writeCompactSettings(
  store: CompactSettingsStore,
  patch: CompactSettingsPatch
): CompactSettings {
  if (typeof store.setDaemonControl !== 'function') {
    throw new Error('compact settings store cannot persist');
  }
  const current = readCompactSettings(store);
  const next = normalizeCompactSettings({
    ...current,
    ...patch,
    updatedAt: nowIso()
  });
  store.setDaemonControl(COMPACT_SETTINGS_KEY, next);
  return next;
}

/**
 * Effective micro-compact config for the model view.
 * Persisted Lab policy/keepRecent win when the UI has saved once.
 */
export function resolveMicroCompactConfig(input: {
  store?: { getDaemonControl?(key: string): unknown };
  env?: NodeJS.ProcessEnv;
}): MicroCompactConfig {
  const envCfg = microCompactConfigFromEnv(input.env);
  if (!hasPersistedCompactSettings(input.store) || !input.store?.getDaemonControl) {
    return { ...envCfg, policy: envCfg.policy ?? 'keep_recent' };
  }
  const saved = readCompactSettings({
    getDaemonControl: (key) => input.store!.getDaemonControl!(key)
  });
  return {
    ...envCfg,
    policy: saved.policy,
    keepRecent: saved.keepRecent,
    ...(typeof saved.enabled === 'boolean' ? { enabled: saved.enabled } : {})
  };
}

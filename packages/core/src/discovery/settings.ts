/**
 * Capability Discovery runtime settings — persisted in daemon_control KV.
 * UI / API is the primary control plane; env vars are CI/bootstrap fallback only.
 */

import { envBool } from '../env.js';
import { nowIso } from '../id.js';

export const DISCOVERY_SETTINGS_KEY = 'discovery_settings';

export interface DiscoverySettings {
  /** Master switch for Registry API, Tool Search, adapters. */
  enabled: boolean;
  /** Tailscale inventory / list-get tools. Implies discovery enabled for those ops. */
  tailscaleEnabled: boolean;
  /** Dangerous: active port/host scan. Default off. */
  activeScanEnabled: boolean;
  hostAllowlist: string[];
  cidrAllowlist: string[];
  /** Optional path to mock `tailscale status --json` (tests / offline). */
  statusJsonPath?: string;
  updatedAt: string;
}

export interface DiscoverySettingsPatch {
  enabled?: boolean;
  tailscaleEnabled?: boolean;
  activeScanEnabled?: boolean;
  hostAllowlist?: string[];
  cidrAllowlist?: string[];
  statusJsonPath?: string | null;
}

export interface DiscoverySettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export function defaultDiscoverySettings(): DiscoverySettings {
  return {
    enabled: true,
    tailscaleEnabled: false,
    activeScanEnabled: false,
    hostAllowlist: [],
    cidrAllowlist: [],
    updatedAt: nowIso()
  };
}

function normalizeList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

export function normalizeDiscoverySettings(raw: Partial<DiscoverySettings> | null | undefined): DiscoverySettings {
  const base = defaultDiscoverySettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: Boolean(raw.enabled),
    tailscaleEnabled: Boolean(raw.tailscaleEnabled),
    activeScanEnabled: Boolean(raw.activeScanEnabled),
    hostAllowlist: normalizeList(raw.hostAllowlist),
    cidrAllowlist: normalizeList(raw.cidrAllowlist),
    statusJsonPath:
      typeof raw.statusJsonPath === 'string' && raw.statusJsonPath.trim()
        ? raw.statusJsonPath.trim()
        : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

/** Returns persisted settings, or defaults when never configured via UI/API. */
export function readDiscoverySettings(store: DiscoverySettingsStore): DiscoverySettings {
  const saved = store.getDaemonControl<Partial<DiscoverySettings>>(DISCOVERY_SETTINGS_KEY);
  if (!saved) return defaultDiscoverySettings();
  return normalizeDiscoverySettings(saved);
}

export function writeDiscoverySettings(
  store: DiscoverySettingsStore,
  patch: DiscoverySettingsPatch
): DiscoverySettings {
  const current = readDiscoverySettings(store);
  const next = normalizeDiscoverySettings({
    ...current,
    ...patch,
    hostAllowlist: patch.hostAllowlist !== undefined ? patch.hostAllowlist : current.hostAllowlist,
    cidrAllowlist: patch.cidrAllowlist !== undefined ? patch.cidrAllowlist : current.cidrAllowlist,
    statusJsonPath:
      patch.statusJsonPath === null
        ? undefined
        : patch.statusJsonPath !== undefined
          ? patch.statusJsonPath
          : current.statusJsonPath,
    updatedAt: nowIso()
  });
  store.setDaemonControl(DISCOVERY_SETTINGS_KEY, next);
  return next;
}

function isSettingsStore(store: unknown): store is DiscoverySettingsStore {
  return (
    !!store &&
    typeof (store as DiscoverySettingsStore).getDaemonControl === 'function' &&
    typeof (store as DiscoverySettingsStore).setDaemonControl === 'function'
  );
}

export function hasPersistedDiscoverySettings(store: DiscoverySettingsStore | undefined): boolean {
  if (!isSettingsStore(store)) return false;
  return store.getDaemonControl(DISCOVERY_SETTINGS_KEY) != null;
}

/**
 * Effective discovery master switch.
 * Persisted UI/API settings win when present.
 * Otherwise RAW_AGENT_DISCOVERY: missing defaults to on; 0/false/no/off turns it off.
 */
export function resolveDiscoveryEnabled(
  store: DiscoverySettingsStore | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (isSettingsStore(store) && hasPersistedDiscoverySettings(store)) {
    return readDiscoverySettings(store).enabled;
  }
  return envBool(env, 'RAW_AGENT_DISCOVERY', true);
}

/**
 * Effective Tailscale discovery switch.
 * Requires discovery enabled; persisted settings win when present.
 */
export function resolveTailscaleDiscoveryEnabled(
  store: DiscoverySettingsStore | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!resolveDiscoveryEnabled(store, env)) return false;
  if (isSettingsStore(store) && hasPersistedDiscoverySettings(store)) {
    return readDiscoverySettings(store).tailscaleEnabled;
  }
  return envBool(env, 'RAW_AGENT_TAILSCALE_DISCOVERY', false);
}

/** Merge probe policy inputs: persisted allowlists override empty env when set. */
export function resolveDiscoveryProbeOverrides(store: DiscoverySettingsStore | undefined): {
  activeScanEnabled?: boolean;
  hostAllowlist?: string[];
  cidrAllowlist?: string[];
  statusJsonPath?: string;
} {
  if (!isSettingsStore(store) || !hasPersistedDiscoverySettings(store)) return {};
  const s = readDiscoverySettings(store);
  return {
    activeScanEnabled: s.activeScanEnabled,
    hostAllowlist: s.hostAllowlist,
    cidrAllowlist: s.cidrAllowlist,
    statusJsonPath: s.statusJsonPath
  };
}

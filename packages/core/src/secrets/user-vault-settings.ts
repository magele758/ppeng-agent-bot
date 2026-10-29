/**
 * UserVault assistant exposure — Lab KV (`user_vault_settings`), default off.
 * Controls only whether `vault_*` tools are offered to the model; entries themselves
 * stay in UserVault (`user_vault`), never in SecretVault.
 */

import { ValidationError } from '../errors.js';

export const USER_VAULT_SETTINGS_KEY = 'user_vault_settings';

export const USER_VAULT_TOOL_NAMES = ['vault_list', 'vault_get', 'vault_fill'] as const;

export interface UserVaultSettings {
  enabled: boolean;
}

interface SettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

interface SettingsReadStore {
  getDaemonControl?: (key: string) => unknown;
}

export function readUserVaultSettings(store: SettingsReadStore | undefined): UserVaultSettings {
  const saved = store?.getDaemonControl?.(USER_VAULT_SETTINGS_KEY) as Partial<UserVaultSettings> | undefined;
  return { enabled: saved?.enabled === true };
}

export function writeUserVaultSettings(
  store: SettingsStore,
  patch: Partial<UserVaultSettings>
): UserVaultSettings {
  if (patch.enabled != null && typeof patch.enabled !== 'boolean') {
    throw new ValidationError('enabled must be boolean');
  }
  const next = { ...readUserVaultSettings(store), ...(patch.enabled != null ? { enabled: patch.enabled } : {}) };
  store.setDaemonControl(USER_VAULT_SETTINGS_KEY, next);
  return next;
}

/** Drop `vault_*` tools unless the Lab toggle is on. */
export function filterUserVaultTools<T extends { name: string }>(
  tools: T[],
  store: SettingsReadStore | undefined
): T[] {
  if (readUserVaultSettings(store).enabled) return tools;
  const hidden = new Set<string>(USER_VAULT_TOOL_NAMES);
  return tools.filter((tool) => !hidden.has(tool.name));
}

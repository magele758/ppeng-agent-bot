/**
 * System prompt variant Lab settings — daemon_control KV.
 * Operators pick anthropic5 | legacy in the Lab UI. No env feature switch.
 * Default: anthropic5. Selecting legacy is the rollback.
 */

import { nowIso } from '../id.js';

export const PROMPT_VARIANT_SETTINGS_KEY = 'prompt_variant_settings';

export type PromptVariant = 'anthropic5' | 'legacy';

export interface PromptVariantSettings {
  variant: PromptVariant;
  updatedAt: string;
}

export interface PromptVariantSettingsPatch {
  variant?: PromptVariant;
}

export interface PromptVariantSettingsStore {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

const VARIANTS: readonly PromptVariant[] = ['anthropic5', 'legacy'];

let loggedActiveVariant: string | null = null;

export function defaultPromptVariantSettings(): PromptVariantSettings {
  return {
    variant: 'anthropic5',
    updatedAt: nowIso()
  };
}

function isVariant(v: unknown): v is PromptVariant {
  return v === 'anthropic5' || v === 'legacy';
}

export function normalizePromptVariantSettings(
  raw: Partial<PromptVariantSettings> | null | undefined
): PromptVariantSettings {
  const base = defaultPromptVariantSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    variant: isVariant(raw.variant) ? raw.variant : base.variant,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function isSettingsStore(store: unknown): store is PromptVariantSettingsStore {
  return !!store && typeof (store as PromptVariantSettingsStore).getDaemonControl === 'function';
}

export function hasPersistedPromptVariantSettings(
  store: PromptVariantSettingsStore | undefined
): boolean {
  if (!isSettingsStore(store)) return false;
  return store.getDaemonControl?.(PROMPT_VARIANT_SETTINGS_KEY) != null;
}

export function readPromptVariantSettings(
  store: PromptVariantSettingsStore | undefined
): PromptVariantSettings {
  if (!isSettingsStore(store)) return defaultPromptVariantSettings();
  const saved = store.getDaemonControl?.(PROMPT_VARIANT_SETTINGS_KEY);
  if (!saved || typeof saved !== 'object') return defaultPromptVariantSettings();
  return normalizePromptVariantSettings(saved as Partial<PromptVariantSettings>);
}

/** Log one line naming the active variant (ops can flip back to legacy in Lab UI). */
export function logActivePromptVariant(variant: PromptVariant, reason: string): void {
  const line = `[prompt] active variant=${variant} (${reason})`;
  if (loggedActiveVariant === line) return;
  loggedActiveVariant = line;
  console.info(line);
}

export function writePromptVariantSettings(
  store: PromptVariantSettingsStore,
  patch: PromptVariantSettingsPatch
): PromptVariantSettings {
  if (typeof store.setDaemonControl !== 'function') {
    return readPromptVariantSettings(store);
  }
  const current = readPromptVariantSettings(store);
  const next = normalizePromptVariantSettings({
    ...current,
    ...(isVariant(patch.variant) ? { variant: patch.variant } : {}),
    updatedAt: nowIso()
  });
  store.setDaemonControl(PROMPT_VARIANT_SETTINGS_KEY, next);
  logActivePromptVariant(next.variant, 'settings-write');
  return next;
}

/** Effective variant. Never reads a feature-switch env. Logs once per process on first resolve. */
export function resolvePromptVariant(store: PromptVariantSettingsStore | undefined): PromptVariant {
  const settings = readPromptVariantSettings(store);
  logActivePromptVariant(
    settings.variant,
    hasPersistedPromptVariantSettings(store) ? 'ui' : 'default'
  );
  return settings.variant;
}

export function promptVariantOptions(): readonly PromptVariant[] {
  return VARIANTS;
}

/** Test helper: reset one-shot log guard. */
export function resetPromptVariantLogGuardForTests(): void {
  loggedActiveVariant = null;
}

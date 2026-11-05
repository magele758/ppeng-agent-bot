/**
 * Thinking effort Lab settings — daemon_control KV.
 * Operators pick off | low | medium | high in the Lab UI. No env feature switch.
 * Default off: chat requests omit the effort field, matching the previous wire format.
 */

import { nowIso } from '../id.js';

export const THINKING_EFFORT_SETTINGS_KEY = 'thinking_effort_settings';

export type ThinkingEffortLevel = 'off' | 'low' | 'medium' | 'high';
export type ReasoningEffort = Exclude<ThinkingEffortLevel, 'off'>;

export interface ThinkingEffortSettings {
  level: ThinkingEffortLevel;
  updatedAt: string;
}

export interface ThinkingEffortSettingsPatch {
  level?: ThinkingEffortLevel;
}

export interface ThinkingEffortSettingsStore {
  getDaemonControl?(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

const LEVELS: readonly ThinkingEffortLevel[] = ['off', 'low', 'medium', 'high'];

export function defaultThinkingEffortSettings(): ThinkingEffortSettings {
  return { level: 'off', updatedAt: nowIso() };
}

export function isThinkingEffortLevel(value: unknown): value is ThinkingEffortLevel {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}

export function normalizeThinkingEffortSettings(
  raw: Partial<ThinkingEffortSettings> | null | undefined
): ThinkingEffortSettings {
  const base = defaultThinkingEffortSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    level: isThinkingEffortLevel(raw.level) ? raw.level : base.level,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function isSettingsStore(store: unknown): store is ThinkingEffortSettingsStore {
  return !!store && typeof (store as ThinkingEffortSettingsStore).getDaemonControl === 'function';
}

export function hasPersistedThinkingEffortSettings(
  store: ThinkingEffortSettingsStore | undefined
): boolean {
  if (!isSettingsStore(store)) return false;
  return store.getDaemonControl?.(THINKING_EFFORT_SETTINGS_KEY) != null;
}

export function readThinkingEffortSettings(
  store: ThinkingEffortSettingsStore | undefined
): ThinkingEffortSettings {
  if (!isSettingsStore(store)) return defaultThinkingEffortSettings();
  const saved = store.getDaemonControl?.(THINKING_EFFORT_SETTINGS_KEY);
  if (!saved || typeof saved !== 'object') return defaultThinkingEffortSettings();
  return normalizeThinkingEffortSettings(saved as Partial<ThinkingEffortSettings>);
}

export function writeThinkingEffortSettings(
  store: ThinkingEffortSettingsStore,
  patch: ThinkingEffortSettingsPatch
): ThinkingEffortSettings {
  if (typeof store.setDaemonControl !== 'function') return readThinkingEffortSettings(store);
  const current = readThinkingEffortSettings(store);
  const next = normalizeThinkingEffortSettings({
    ...current,
    ...(isThinkingEffortLevel(patch.level) ? { level: patch.level } : {}),
    updatedAt: nowIso()
  });
  store.setDaemonControl(THINKING_EFFORT_SETTINGS_KEY, next);
  return next;
}

/** Saved level. Never reads a feature-switch env. Unsaved settings stay off. */
export function resolveThinkingEffort(
  store: ThinkingEffortSettingsStore | undefined
): ThinkingEffortLevel {
  return readThinkingEffortSettings(store).level;
}

export function thinkingEffortOptions(): readonly ThinkingEffortLevel[] {
  return LEVELS;
}

/** Stamp the saved level onto the next chat turn. Off removes the field. */
export function applyThinkingEffortToTurn<T extends { reasoningEffort?: ReasoningEffort }>(
  input: T,
  store: ThinkingEffortSettingsStore | undefined
): T {
  const level = resolveThinkingEffort(store);
  if (level === 'off') {
    const { reasoningEffort: _drop, ...rest } = input;
    return rest as T;
  }
  return { ...input, reasoningEffort: level };
}

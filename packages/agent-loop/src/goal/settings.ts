import { nowIso } from '../helpers.js';

export const GOAL_SETTINGS_KEY = 'goal_settings';

export interface GoalSettings {
  /** Persist + evaluate GoalRecord independently of session.metadata. Default on. */
  entityEnabled: boolean;
  defaultMaxTurns: number;
  allowHttpVerify: boolean;
  /** Command verify is stored only; runtime never executes unless this is true (still refused today). */
  allowCommandVerify: boolean;
  updatedAt: string;
}

export interface GoalSettingsPatch {
  entityEnabled?: boolean;
  defaultMaxTurns?: number;
  allowHttpVerify?: boolean;
  allowCommandVerify?: boolean;
}

export interface GoalSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl?(key: string, value: unknown): void;
}

export function defaultGoalSettings(): GoalSettings {
  return {
    entityEnabled: true,
    defaultMaxTurns: 0,
    allowHttpVerify: true,
    allowCommandVerify: false,
    updatedAt: nowIso()
  };
}

export function normalizeGoalSettings(raw: Partial<GoalSettings> | null | undefined): GoalSettings {
  const base = defaultGoalSettings();
  if (!raw || typeof raw !== 'object') return base;
  const maxTurns =
    typeof raw.defaultMaxTurns === 'number' && Number.isFinite(raw.defaultMaxTurns)
      ? raw.defaultMaxTurns <= 0
        ? 0
        : Math.max(1, Math.min(100, Math.floor(raw.defaultMaxTurns)))
      : base.defaultMaxTurns;
  return {
    entityEnabled: raw.entityEnabled !== false,
    defaultMaxTurns: maxTurns,
    allowHttpVerify: raw.allowHttpVerify !== false,
    allowCommandVerify: raw.allowCommandVerify === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

export function readGoalSettings(store: GoalSettingsStore): GoalSettings {
  const saved = store.getDaemonControl<Partial<GoalSettings>>(GOAL_SETTINGS_KEY);
  if (!saved) return defaultGoalSettings();
  return normalizeGoalSettings(saved);
}

export function writeGoalSettings(store: GoalSettingsStore, patch: GoalSettingsPatch): GoalSettings {
  const next = normalizeGoalSettings({
    ...readGoalSettings(store),
    ...patch,
    updatedAt: nowIso()
  });
  if (!store.setDaemonControl) {
    throw new Error('Goal settings store is read-only');
  }
  store.setDaemonControl(GOAL_SETTINGS_KEY, next);
  return next;
}

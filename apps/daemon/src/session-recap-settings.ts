/**
 * Session-recap switches. Lab UI persists them in daemon_control.
 * No RAW_AGENT_* flag.
 * `active` turns the whole recap off. `enabled` only skips the automatic return.
 */

export const SESSION_RECAP_SETTINGS_KEY = 'session_recap_settings';

export interface SessionRecapSettings {
  /** When false, recap is off: no line, no button, no model call. Default on. */
  active: boolean;
  /** When false, returning to a session does not show a recap. Default on. */
  enabled: boolean;
  updatedAt: string;
}

export interface SessionRecapSettingsPatch {
  active?: boolean;
  enabled?: boolean;
}

export interface SessionRecapSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export function defaultSessionRecapSettings(now = new Date().toISOString()): SessionRecapSettings {
  return { active: true, enabled: true, updatedAt: now };
}

/** False means the model must not be asked to write a recap. */
export function recapFeatureEnabled(settings: Pick<SessionRecapSettings, 'active'>): boolean {
  return settings.active !== false;
}

export function normalizeSessionRecapSettings(
  raw: Partial<SessionRecapSettings> | null | undefined,
  now = new Date().toISOString()
): SessionRecapSettings {
  const base = defaultSessionRecapSettings(now);
  if (!raw || typeof raw !== 'object') return base;
  return {
    active: raw.active === false ? false : true,
    enabled: raw.enabled === false ? false : true,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : base.updatedAt
  };
}

export function readSessionRecapSettings(
  store: SessionRecapSettingsStore,
  now = new Date().toISOString()
): SessionRecapSettings {
  const saved = store.getDaemonControl<Partial<SessionRecapSettings>>(SESSION_RECAP_SETTINGS_KEY);
  if (!saved) return defaultSessionRecapSettings(now);
  return normalizeSessionRecapSettings(saved, now);
}

export function writeSessionRecapSettings(
  store: SessionRecapSettingsStore,
  patch: SessionRecapSettingsPatch,
  now = new Date().toISOString()
): SessionRecapSettings {
  const current = readSessionRecapSettings(store, now);
  const next = normalizeSessionRecapSettings({ ...current, ...patch, updatedAt: now }, now);
  store.setDaemonControl(SESSION_RECAP_SETTINGS_KEY, next);
  return next;
}

export function hasPersistedSessionRecapSettings(store: SessionRecapSettingsStore): boolean {
  return store.getDaemonControl(SESSION_RECAP_SETTINGS_KEY) != null;
}

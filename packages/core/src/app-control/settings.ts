/**
 * Lab switch for macOS app control. Default off. No RAW_AGENT_* feature flag.
 * The value lives in daemon_control, same style as computer_use_settings.
 */

export const APP_CONTROL_SETTINGS_KEY = 'app_control_settings';

export const APP_CONTROL_TOOL_NAMES = ['app_activate', 'app_type_text', 'app_keystroke'] as const;

export type AppControlToolName = (typeof APP_CONTROL_TOOL_NAMES)[number];

export interface AppControlSettings {
  enabled: boolean;
}

export function isAppControlToolName(name: string): name is AppControlToolName {
  return (APP_CONTROL_TOOL_NAMES as readonly string[]).includes(name);
}

export function readAppControlSettings(store?: {
  getDaemonControl?: (key: string) => unknown;
} | null): AppControlSettings {
  const saved = store?.getDaemonControl?.(APP_CONTROL_SETTINGS_KEY) as Partial<AppControlSettings> | undefined;
  return { enabled: saved?.enabled === true };
}

export function writeAppControlSettings(
  store: {
    getDaemonControl?: (key: string) => unknown;
    setDaemonControl: (key: string, value: unknown) => void;
  },
  patch: { enabled?: unknown }
): AppControlSettings {
  if (patch.enabled != null && typeof patch.enabled !== 'boolean') {
    throw new Error('enabled must be boolean');
  }
  const settings: AppControlSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : readAppControlSettings(store).enabled
  };
  store.setDaemonControl(APP_CONTROL_SETTINGS_KEY, settings);
  return settings;
}

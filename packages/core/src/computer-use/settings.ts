import { isAbsolute } from 'node:path';
import { defaultLcuCommand } from './lcu-provider.js';
export const LCU_SETTINGS_KEY = 'computer_use_settings';
export interface LcuSettings { enabled: boolean; command: string }
interface SettingsStore { getDaemonControl<T>(key: string): T | undefined; setDaemonControl(key: string, value: unknown): void }
export function readLcuSettings(store: SettingsStore): LcuSettings {
  const saved = store.getDaemonControl<Partial<LcuSettings>>(LCU_SETTINGS_KEY);
  return { enabled: saved?.enabled === true, command: saved?.command || defaultLcuCommand() };
}
export function writeLcuSettings(store: SettingsStore, patch: Partial<LcuSettings>): LcuSettings {
  const current = readLcuSettings(store);
  if (patch.command != null && (typeof patch.command !== 'string' || !isAbsolute(patch.command))) throw new Error('LCU command must be an absolute path');
  if (patch.enabled != null && typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean');
  const settings = { ...current, ...patch }; store.setDaemonControl(LCU_SETTINGS_KEY, settings); return settings;
}

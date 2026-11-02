import { PREFERENCES_CHANGED, receivePreferences } from './user-preference-storage.ts';
import { createPreferenceSync } from './user-preference-sync.ts';
export const DEBUG_DISPLAY_KEY = 'lab.debugDisplay';
export function parseDebugDisplay(value: string | null | undefined): boolean {
  return value === '1';
}
export function readDebugDisplay(): boolean {
  try { return parseDebugDisplay(window.localStorage.getItem(DEBUG_DISPLAY_KEY)); }
  catch { return false; }
}
export function subscribeDebugDisplay(listener: () => void): () => void {
  window.addEventListener(PREFERENCES_CHANGED, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(PREFERENCES_CHANGED, listener);
    window.removeEventListener('storage', listener);
  };
}
export async function saveDebugDisplay(enabled: boolean, request: (path: string, init?: RequestInit) => Promise<unknown>): Promise<void> {
  const values = await createPreferenceSync(request).save({ [DEBUG_DISPLAY_KEY]: enabled ? '1' : '0' });
  receivePreferences(values);
}

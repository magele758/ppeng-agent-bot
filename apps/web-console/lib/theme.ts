import { preferenceStorage } from './user-preference-storage.ts';
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';
export const THEME_CHANGED_EVENT = 'ppeng-theme-changed';

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light';
  return pref;
}

export function readThemePreference(): ThemePreference {
  return parseThemePreference(preferenceStorage.getItem(THEME_STORAGE_KEY));
}

export function currentTheme(): ResolvedTheme {
  return resolveTheme(readThemePreference(), window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** `system` removes the stored key so the pre-hydration script keeps following the OS. */
export function applyThemePreference(pref: ThemePreference): void {
  if (pref === 'system') preferenceStorage.removeItem(THEME_STORAGE_KEY);
  else preferenceStorage.setItem(THEME_STORAGE_KEY, pref);
  document.documentElement.setAttribute('data-theme', currentTheme());
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}

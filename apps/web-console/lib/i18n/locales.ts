import { preferenceStorage } from '../user-preference-storage.ts';
export type Locale = 'zh' | 'en';

export const LOCALES: readonly Locale[] = ['zh', 'en'];

export const DEFAULT_LOCALE: Locale = 'zh';

export const LOCALE_STORAGE_KEY = 'lab.locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function parseLocale(value: unknown): Locale | undefined {
  return isLocale(value) ? value : undefined;
}

export function localeFromNavigator(lang: string | undefined | null): Locale {
  if (lang == null) return DEFAULT_LOCALE;
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  if (normalized.startsWith('zh')) return 'zh';
  return 'en';
}

export function resolveLocale(input: {
  stored?: string | null;
  navigatorLanguage?: string | null;
}): Locale {
  const stored = parseLocale(input.stored);
  if (stored) return stored;
  return localeFromNavigator(input.navigatorLanguage);
}

export function localeHtmlLang(locale: Locale): string {
  switch (locale) {
    case 'zh':
      return 'zh-CN';
    case 'en':
      return 'en';
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

export function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return parseLocale(preferenceStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    preferenceStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // private mode / quota
  }
}

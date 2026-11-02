'use client';

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  localeHtmlLang,
  resolveLocale,
  writeStoredLocale,
  type Locale
} from './locales';
import { usePreferenceRevision } from '../../components/usePreferenceRevision';
import { en } from './messages/en';
import type { MessageKey, Messages } from './messages/types';
import { zh } from './messages/zh';
import { translate } from './t';

export type I18nContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  messages: Messages;
};

export const I18nContext = createContext<I18nContextValue | null>(null);

function messagesForLocale(locale: Locale): Messages {
  switch (locale) {
    case 'zh':
      return zh;
    case 'en':
      return en;
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const preferenceRevision = usePreferenceRevision();
  // 首次 render 固定默认语言，避免 hydration mismatch
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const next = resolveLocale({
      stored: window.localStorage.getItem(LOCALE_STORAGE_KEY),
      navigatorLanguage: window.navigator.language
    });
    setLocaleState(next);
    document.documentElement.lang = localeHtmlLang(next);
    document.documentElement.dataset.i18nReady = next;
  }, [preferenceRevision]);

  const setLocale = useCallback((next: Locale) => {
    writeStoredLocale(next);
    setLocaleState(next);
    document.documentElement.lang = localeHtmlLang(next);
    document.documentElement.dataset.i18nReady = next;
  }, []);

  const messages = useMemo(() => messagesForLocale(locale), [locale]);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(messages, key, vars, zh),
    [messages]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t, messages }),
    [locale, setLocale, t, messages]
  );

  return (
    <I18nContext.Provider value={value}>
      <span hidden data-testid="i18n-locale" data-locale={locale} />
      {children}
    </I18nContext.Provider>
  );
}

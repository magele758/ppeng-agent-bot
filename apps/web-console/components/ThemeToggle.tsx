'use client';

import { useI18n } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import {
  THEME_CHANGED_EVENT,
  applyThemePreference,
  currentTheme,
  type ResolvedTheme
} from '@/lib/theme';

export function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ResolvedTheme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const sync = () => setTheme(currentTheme());
    sync();
    setMounted(true);
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, sync);
  }, []);

  const toggleTheme = () => applyThemePreference(theme === 'dark' ? 'light' : 'dark');

  if (!mounted) {
    return (
      <button type="button" className="btn-ghost btn-icon" aria-label={t('common.theme')} disabled>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3.5" />
        </svg>
      </button>
    );
  }

  const label = theme === 'dark' ? t('common.themeToLight') : t('common.themeToDark');
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        toggleTheme();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleTheme();
      }}
      className="btn-ghost btn-icon"
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="3.5" />
          <line x1="8" y1="1" x2="8" y2="2.5" />
          <line x1="8" y1="13.5" x2="8" y2="15" />
          <line x1="15" y1="8" x2="13.5" y2="8" />
          <line x1="2.5" y1="8" x2="1" y2="8" />
          <line x1="13.25" y1="2.75" x2="12.19" y2="3.81" />
          <line x1="3.81" y1="12.19" x2="2.75" y2="13.25" />
          <line x1="13.25" y1="13.25" x2="12.19" y2="12.19" />
          <line x1="3.81" y1="3.81" x2="2.75" y2="2.75" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 8.5A6.5 6.5 0 1 1 7.5 2c.5 0 1 .1 1.4.2A5.5 5.5 0 0 0 13.8 7c.1.5.2.9.2 1.5z" />
        </svg>
      )}
    </button>
  );
}

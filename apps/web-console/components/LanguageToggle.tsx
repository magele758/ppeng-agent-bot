'use client';

import { LOCALES, useI18n, type Locale } from '@/lib/i18n';

function localeEndonym(locale: Locale): string {
  switch (locale) {
    case 'zh':
      return '中文';
    case 'en':
      return 'English';
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div
      className="language-toggle"
      data-testid="language-toggle"
      role="group"
      aria-label={t('common.language')}
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
    >
      {LOCALES.map((code) => {
        const pressed = locale === code;
        return (
          <button
            key={code}
            type="button"
            className={pressed ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
            aria-pressed={pressed}
            aria-label={localeEndonym(code)}
            title={localeEndonym(code)}
            onClick={() => setLocale(code)}
          >
            {compact ? (code === 'zh' ? '中' : 'EN') : localeEndonym(code)}
          </button>
        );
      })}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { applyFontSize, DEFAULT_FONT_SIZE, FONT_SIZES, normalizeFontSize } from '@/lib/font-size';
import { SettingsGroup } from './ui';

export function FontSizeSettingsCard() {
  const { t } = useI18n();
  const [size, setSize] = useState<number>(DEFAULT_FONT_SIZE);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    setSize(normalizeFontSize(document.documentElement.getAttribute('data-font-size')));
  }, []);
  const choose = (value: number) => {
    setSize(value);
    setSaveFailed(!applyFontSize(value));
  };
  return (
    <div className="card" id="card-font-size">
      <SettingsGroup title={t('settings.fontSize.title')} description={t('settings.fontSize.description')}>
        <div className="font-size-controls">
          <label htmlFor="font-size-choice">{t('settings.fontSize.title')}</label>
          <select id="font-size-choice" value={size} onChange={event => choose(Number(event.target.value))}
            onKeyDown={event => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              const index = FONT_SIZES.findIndex(value => value === size);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? FONT_SIZES.length - 1
                : event.key === 'ArrowDown' ? Math.min(index + 1, FONT_SIZES.length - 1)
                : event.key === 'ArrowUp' ? Math.max(index - 1, 0) : null;
              if (next === null) return;
              event.preventDefault();
              choose(FONT_SIZES[next]);
            }}>
            {FONT_SIZES.map(value => <option key={value} value={value}>{t(value === DEFAULT_FONT_SIZE ? 'settings.fontSize.defaultOption' : 'settings.fontSize.option', { size: value })}</option>)}
          </select>
          <button type="button" className="btn btn-ghost" onClick={() => choose(DEFAULT_FONT_SIZE)}>{t('settings.fontSize.reset')}</button>
        </div>
        <p className="font-size-preview">{t('settings.fontSize.preview')}</p>
        {saveFailed && <p role="alert">{t('settings.fontSize.saveFailed')}</p>}
      </SettingsGroup>
    </div>
  );
}

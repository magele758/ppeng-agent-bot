'use client';

import { useEffect, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  THEME_CHANGED_EVENT,
  applyThemePreference,
  readThemePreference,
  type ThemePreference
} from '@/lib/theme';
import { SKIN_CHANGED_EVENT, SKIN_IDS, applySkin, readSkin, type SkinId } from '@/lib/skin';
import { SettingsGroup } from './ui';

const OPTIONS: ThemePreference[] = ['light', 'dark', 'system'];

export function ThemeSettingsCard() {
  const { t } = useI18n();
  const [pref, setPref] = useState<ThemePreference>('system');
  const [skin, setSkin] = useState<SkinId>('classic');
  useEffect(() => {
    const sync = () => {
      setPref(readThemePreference());
      setSkin(readSkin());
    };
    sync();
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    window.addEventListener(SKIN_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, sync);
      window.removeEventListener(SKIN_CHANGED_EVENT, sync);
    };
  }, []);

  return (
    <div className="card" id="card-theme">
      <SettingsGroup title={t('common.theme')} description={t('settings.theme.desc')}>
        <div className="seg-group" role="radiogroup" aria-label={t('common.theme')}>
          {OPTIONS.map((id) => (
            <label key={id} className={`seg-option${pref === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="theme-preference"
                value={id}
                checked={pref === id}
                onChange={() => applyThemePreference(id)}
              />
              <span>{t(`settings.theme.${id}` as MessageKey)}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('settings.skin.label')} description={t('settings.skin.desc')}>
        <div className="seg-group" role="radiogroup" aria-label={t('settings.skin.label')}>
          {SKIN_IDS.map((id) => (
            <label key={id} className={`seg-option${skin === id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="skin-preference"
                value={id}
                checked={skin === id}
                onChange={() => applySkin(id)}
              />
              <span>{t(`settings.skin.${id}` as MessageKey)}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>
    </div>
  );
}

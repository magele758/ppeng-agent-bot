'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { readDebugDisplay, saveDebugDisplay, subscribeDebugDisplay } from '@/lib/debug-display';
import { SettingsGroup } from './ui';

const serverSnapshot = () => false;
function useDebugDisplay() {
  return useSyncExternalStore(subscribeDebugDisplay, readDebugDisplay, serverSnapshot);
}
export function DebugOnly({ children }: { children: ReactNode }) {
  const enabled = useDebugDisplay();
  return enabled ? children : null;
}
export function DebugDisplaySettingsCard() {
  const { t } = useI18n();
  const enabled = useDebugDisplay();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const change = async (value: boolean) => {
    setSaving(true);
    setFailed(false);
    try { await saveDebugDisplay(value, api); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  };
  return <div className="card" id="card-debug-display">
    <SettingsGroup title={t('settings.debugDisplay.title')} description={t('settings.debugDisplay.description')}>
      <label><input type="checkbox" checked={enabled} disabled={saving} onChange={event => void change(event.target.checked)} /> {t('settings.debugDisplay.enable')}</label>
      {failed && <p role="alert">{t('settings.debugDisplay.saveFailed')}</p>}
    </SettingsGroup>
  </div>;
}

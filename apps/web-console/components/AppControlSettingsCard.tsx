'use client';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { LoadGate, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';

export function AppControlSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<{ enabled: boolean }>('/api/app-control/settings');
  return <div id="card-appControl" className="settings-stack"><SettingsGroup title={t('settingsEntries.appControl.title')} description={t('settingsEntries.appControl.desc')}>
    <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {r.settings ? <ToggleField id="field-appControlEnabled" label={t('settingsEntries.appControl.enabled')} hint={t('settingsEntries.appControl.hint')} checked={r.settings.enabled} disabled={r.busy} defaultText={t('settingsEntries.common.off')} isDefault={!r.settings.enabled} onRestore={() => void r.save({ enabled: false })} onChange={enabled => void r.save({ enabled })} /> : null}
      <StatusLine status={r.status} />
    </LoadGate>
  </SettingsGroup></div>;
}

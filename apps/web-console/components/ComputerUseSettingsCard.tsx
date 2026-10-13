'use client';
import { useI18n } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { LoadGate, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';
export function ComputerUseSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<{enabled:boolean;command:string}>('/api/computer-use/settings');
  return <div id="card-computerUse" className="settings-stack"><SettingsGroup title={t('settingsEntries.computerUse.title')} description={t('settingsEntries.computerUse.desc')}>
    <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {r.settings ? <><ToggleField id="field-computerUseEnabled" label={t('settingsEntries.computerUse.enabled')} hint={t('settingsEntries.computerUse.hint')} checked={r.settings.enabled} disabled={r.busy} defaultText={t('settingsEntries.common.off')} isDefault={!r.settings.enabled} onRestore={() => void r.save({enabled:false})} onChange={enabled => void r.save({enabled})}/><p><code>{r.settings.command}</code></p></> : null}
      <StatusLine status={r.status}/>
    </LoadGate>
  </SettingsGroup></div>;
}

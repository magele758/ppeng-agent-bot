'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { LoadGate, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

interface SessionRecapSettings {
  enabled: boolean;
  updatedAt: string;
}

interface SessionRecapEffective {
  enabled: boolean;
  source: string;
}

const PATH = '/api/session-recap/settings';

export function SessionRecapSettingsCard() {
  const { t } = useI18n();
  const resource = useSettingsResource<SessionRecapSettings, SessionRecapEffective>(PATH);
  const settings = resource.settings;
  const label = (path: string) => t(`settingsEntries.sessionRecap.${path}` as MessageKey);

  return (
    <SettingsGroup id="card-session-recap" title={label('title')} description={label('desc')}>
      <LoadGate ready={settings !== null} error={resource.loadError} onRetry={() => void resource.reload()}>
        {settings ? (
          <>
            <ToggleField
              id="field-sessionRecapEnabled"
              label={label('fields.enabled.label')}
              hint={label('fields.enabled.hint')}
              defaultText={t('settingsEntries.common.on')}
              isDefault={settings.enabled}
              onRestore={() => void resource.save({ enabled: true })}
              checked={settings.enabled}
              disabled={resource.busy}
              onChange={(enabled) => void resource.save({ enabled })}
            />
            <StatusLine status={resource.status} />
          </>
        ) : null}
      </LoadGate>
    </SettingsGroup>
  );
}

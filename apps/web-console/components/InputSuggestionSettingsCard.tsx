'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { LoadGate, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

interface InputSuggestionSettings {
  enabled: boolean;
  updatedAt: string;
}

interface InputSuggestionEffective {
  enabled: boolean;
  source: string;
}

const PATH = '/api/input-suggestion/settings';

export function InputSuggestionSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<InputSuggestionSettings, InputSuggestionEffective>(PATH);
  const s = r.settings;
  const label = (path: string) => t(`settingsEntries.inputSuggestion.${path}` as MessageKey);

  return (
    <SettingsGroup id="card-input-suggestion" title={label('title')} description={label('desc')}>
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <>
            <ToggleField
              id="field-inputSuggestionEnabled"
              label={label('fields.enabled.label')}
              hint={label('fields.enabled.hint')}
              defaultText={t('settingsEntries.common.on')}
              isDefault={s.enabled}
              onRestore={() => void r.save({ enabled: true })}
              checked={s.enabled}
              disabled={r.busy}
              onChange={(enabled) => void r.save({ enabled })}
            />
            <StatusLine status={r.status} />
          </>
        ) : null}
      </LoadGate>
    </SettingsGroup>
  );
}

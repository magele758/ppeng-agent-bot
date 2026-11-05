'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import {
  LoadGate,
  SelectField,
  SourceBadge,
  StatusLine
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';

export type ThinkingEffortLevel = 'off' | 'low' | 'medium' | 'high';

interface ThinkingEffortSettings {
  level: ThinkingEffortLevel;
  updatedAt: string;
}

interface ThinkingEffortEffective {
  level: ThinkingEffortLevel;
  source: string;
}

const PATH = '/api/thinking-effort/settings';
const LEVELS: readonly ThinkingEffortLevel[] = ['off', 'low', 'medium', 'high'];

export function ThinkingEffortSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<ThinkingEffortSettings, ThinkingEffortEffective>(PATH);
  const base = 'settingsEntries.thinkingEffort';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);

  const options = LEVELS.map((level) => ({
    value: level,
    label: label(`options.${level}.label`)
  }));

  return (
    <div className="card" id="card-thinking-effort">
      <SettingsGroup title={label('title')} description={label('desc')}>
        <LoadGate ready={Boolean(r.settings)} error={r.loadError} onRetry={() => void r.reload()}>
          {r.settings ? (
            <>
              <SelectField
                id="thinking-effort"
                label={label('fields.level.label')}
                hint={label('fields.level.hint')}
                value={r.settings.level}
                options={options}
                disabled={r.busy}
                onChange={(value) => void r.save({ level: value })}
              />
              <div className="settings-meta-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <SourceBadge source={r.effective?.source} />
                <span className="muted" style={{ fontSize: '0.75rem' }}>
                  {label('effective')}: {r.effective?.level ?? r.settings.level}
                </span>
              </div>
              <StatusLine status={r.status} />
              <p className="muted" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
                {label('note')}
              </p>
            </>
          ) : null}
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}

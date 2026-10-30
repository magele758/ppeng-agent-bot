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

export type PromptVariant = 'anthropic5' | 'legacy';

interface PromptVariantSettings {
  variant: PromptVariant;
  updatedAt: string;
}

interface PromptVariantEffective {
  variant: PromptVariant;
  source: string;
}

const PATH = '/api/prompt-variant/settings';
const VARIANTS: readonly PromptVariant[] = ['anthropic5', 'legacy'];

export function PromptVariantSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<PromptVariantSettings, PromptVariantEffective>(PATH);
  const base = 'settingsEntries.promptVariant';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);

  const options = VARIANTS.map((v) => ({
    value: v,
    label: label(`options.${v}.label`)
  }));

  return (
    <div className="card" id="card-prompt-variant">
      <SettingsGroup title={label('title')} description={label('desc')}>
        <LoadGate ready={Boolean(r.settings)} error={r.loadError} onRetry={() => void r.reload()}>
          {r.settings ? (
            <>
              <SelectField
                id="prompt-variant"
                label={label('fields.variant.label')}
                hint={label('fields.variant.hint')}
                value={r.settings.variant}
                options={options}
                disabled={r.busy}
                onChange={(value) => void r.save({ variant: value })}
              />
              <div className="settings-meta-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <SourceBadge source={r.effective?.source} />
                <span className="muted" style={{ fontSize: '0.75rem' }}>
                  {label('effective')}: {r.effective?.variant ?? r.settings.variant}
                </span>
              </div>
              <StatusLine status={r.status} />
              <p className="muted" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
                {label('rollbackHint')}
              </p>
            </>
          ) : null}
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}

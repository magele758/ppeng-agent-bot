'use client';

import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import { parseIntInRange } from '@/lib/settings-fields';
import { ExperimentRow, SettingsGroup } from './ui';
import { LoadGate, SaveBar, StatusLine, TextField, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

interface GoalSettings {
  entityEnabled: boolean;
  defaultMaxTurns: number;
  allowHttpVerify: boolean;
  allowCommandVerify: boolean;
}

const DEFAULTS = { entityEnabled: true, defaultMaxTurns: 25, allowHttpVerify: true } as const;
const MAX_TURNS_RANGE = { min: 1, max: 100 } as const;
const EMPTY_FORM = { maxTurns: '' };

export function GoalSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<GoalSettings>('/api/goals/settings');
  const saved = useMemo(() => (r.settings ? { maxTurns: String(r.settings.defaultMaxTurns) } : null), [r.settings]);
  const form = useDraftForm(saved, EMPTY_FORM);
  const onOff = (v: boolean) => t(v ? 'settingsEntries.common.on' : 'settingsEntries.common.off');
  const rangeError = () => t('settingsEntries.common.invalidRange', MAX_TURNS_RANGE);

  const submit = async () => {
    const parsed = parseIntInRange(form.draft.maxTurns, MAX_TURNS_RANGE.min, MAX_TURNS_RANGE.max);
    if (!parsed.ok) {
      form.setError('maxTurns', rangeError());
      return;
    }
    await r.save({ defaultMaxTurns: parsed.value });
  };

  return (
    <SettingsGroup id="card-goal" title={t('settingsEntries.goal.title')} description={t('settingsEntries.goal.desc')}>
      <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {r.settings ? (
          <>
            <ToggleField
              id="field-goalEnabled"
              label={t('settingsEntries.goal.fields.enabled.label')}
              hint={t('settingsEntries.goal.fields.enabled.hint')}
              checked={r.settings.entityEnabled}
              disabled={r.busy}
              defaultText={onOff(DEFAULTS.entityEnabled)}
              isDefault={r.settings.entityEnabled === DEFAULTS.entityEnabled}
              onRestore={() => void r.save({ entityEnabled: DEFAULTS.entityEnabled })}
              onChange={(entityEnabled) => void r.save({ entityEnabled })}
            />
            <TextField
              id="field-goalMaxTurns"
              type="number"
              inputMode="numeric"
              label={t('settingsEntries.goal.fields.maxTurns.label')}
              hint={t('settingsEntries.goal.fields.maxTurns.hint')}
              value={form.draft.maxTurns}
              disabled={r.busy || !r.settings.entityEnabled}
              error={form.errors.maxTurns}
              defaultText={String(DEFAULTS.defaultMaxTurns)}
              isDefault={form.draft.maxTurns === String(DEFAULTS.defaultMaxTurns)}
              onRestore={() => form.set('maxTurns', String(DEFAULTS.defaultMaxTurns))}
              onChange={(v) => form.set('maxTurns', v)}
              onBlur={() => {
                if (!parseIntInRange(form.draft.maxTurns, MAX_TURNS_RANGE.min, MAX_TURNS_RANGE.max).ok) {
                  form.setError('maxTurns', rangeError());
                }
              }}
            />
            <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submit()} onReset={form.reset} />
          </>
        ) : null}
        <StatusLine status={r.status} />
      </LoadGate>
    </SettingsGroup>
  );
}

export function GoalVerifySettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<GoalSettings>('/api/goals/settings');

  return (
    <LoadGate ready={r.settings !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {r.settings ? (
        <ExperimentRow
          id="card-goal-verify"
          switchId="goalVerify"
          title={t('settingsEntries.goalVerify.title')}
          description={t('settingsEntries.goalVerify.desc')}
          on={r.settings.allowHttpVerify}
          busy={r.busy}
          onChange={(allowHttpVerify) => void r.save({ allowHttpVerify })}
        >
          <p className="ui-group__desc">{t('settingsEntries.goalVerify.fields.http.hint')}</p>
        </ExperimentRow>
      ) : null}
      <StatusLine status={r.status} />
    </LoadGate>
  );
}

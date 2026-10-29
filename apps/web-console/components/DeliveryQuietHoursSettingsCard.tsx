'use client';

import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  commitQuietHoursWindow,
  draftFromQuietHours,
  EMPTY_QUIET_HOURS_DRAFT,
  QUIET_HOUR_MAX,
  QUIET_HOUR_MIN,
  QUIET_HOURS_DEFAULTS,
  QUIET_HOURS_PATH,
  quietHoursErrorText,
  type QuietHoursDraft,
  type QuietHoursFieldError,
  type QuietHoursSettings
} from '@/lib/delivery-quiet-hours-form';
import { SettingsGroup } from './ui';
import { LoadGate, SaveBar, StatusLine, TextField, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource, type SettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm, type DraftForm } from './sections/settings/categories/kit/useDraftForm';

function savedDraft(settings: QuietHoursSettings | null): QuietHoursDraft | null {
  if (!settings) return null;
  return draftFromQuietHours(settings);
}

function onOffKey(value: boolean): 'settingsEntries.common.on' | 'settingsEntries.common.off' {
  if (value) return 'settingsEntries.common.on';
  return 'settingsEntries.common.off';
}

function hourErrorText(t: ReturnType<typeof useI18n>['t']): string {
  return t('settingsEntries.common.invalidRange', { min: String(QUIET_HOUR_MIN), max: String(QUIET_HOUR_MAX) });
}

function reportWindowErrors(
  errors: QuietHoursFieldError,
  form: DraftForm<QuietHoursDraft>,
  t: ReturnType<typeof useI18n>['t']
): void {
  form.setErrors(quietHoursErrorText(errors, {
    hour: hourErrorText(t),
    timezone: t('settingsEntries.deliveryQuietHours.fields.timezone.invalid')
  }));
}

export function DeliveryQuietHoursSettingsCard() {
  const { t } = useI18n();
  const resource = useSettingsResource<QuietHoursSettings>(QUIET_HOURS_PATH);
  const saved = useMemo(() => savedDraft(resource.settings), [resource.settings]);
  const form = useDraftForm(saved, EMPTY_QUIET_HOURS_DRAFT);
  return (
    <SettingsGroup
      id="card-delivery-quiet-hours"
      title={t('settingsEntries.deliveryQuietHours.title')}
      description={t('settingsEntries.deliveryQuietHours.desc')}
    >
      <LoadGate ready={resource.settings !== null} error={resource.loadError} onRetry={() => void resource.reload()}>
        <QuietHoursLoaded resource={resource} form={form} />
      </LoadGate>
    </SettingsGroup>
  );
}

function QuietHoursLoaded({
  resource,
  form
}: {
  resource: SettingsResource<QuietHoursSettings, unknown>;
  form: DraftForm<QuietHoursDraft>;
}) {
  const settings = resource.settings;
  if (!settings) return null;
  return (
    <>
      <QuietHoursFields settings={settings} form={form} resource={resource} />
      <StatusLine status={resource.status} />
    </>
  );
}

function QuietHourField({
  id,
  label,
  hint,
  value,
  error,
  defaultHour,
  busy,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error?: string;
  defaultHour: number;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const fallback = String(defaultHour);
  return (
    <TextField
      id={id}
      type="number"
      inputMode="numeric"
      label={label}
      hint={hint}
      value={value}
      disabled={busy}
      error={error}
      defaultText={fallback}
      isDefault={value === fallback}
      onRestore={() => onChange(fallback)}
      onChange={onChange}
    />
  );
}

function QuietHoursFields({
  settings,
  form,
  resource
}: {
  settings: QuietHoursSettings;
  form: DraftForm<QuietHoursDraft>;
  resource: SettingsResource<QuietHoursSettings, unknown>;
}) {
  const { t } = useI18n();
  const onOff = (value: boolean) => t(onOffKey(value));
  const onSave = () => void commitQuietHoursWindow(
    settings,
    form.draft,
    resource,
    (errors) => reportWindowErrors(errors, form, t),
    form.reset
  );
  return (
    <>
      <ToggleField
        id="field-quietEnabled"
        label={t('settingsEntries.deliveryQuietHours.fields.enabled.label')}
        hint={t('settingsEntries.deliveryQuietHours.fields.enabled.hint')}
        checked={settings.enabled}
        disabled={resource.busy}
        defaultText={onOff(QUIET_HOURS_DEFAULTS.enabled)}
        isDefault={settings.enabled === QUIET_HOURS_DEFAULTS.enabled}
        onRestore={() => void resource.save({ enabled: QUIET_HOURS_DEFAULTS.enabled })}
        onChange={(enabled) => void resource.save({ enabled })}
      />
      <QuietHourField
        id="field-quietStart"
        label={t('settingsEntries.deliveryQuietHours.fields.startHour.label')}
        hint={t('settingsEntries.deliveryQuietHours.fields.startHour.hint')}
        value={form.draft.startHour}
        error={form.errors.startHour}
        defaultHour={QUIET_HOURS_DEFAULTS.startHour}
        busy={resource.busy}
        onChange={(value) => form.set('startHour', value)}
      />
      <QuietHourField
        id="field-quietEnd"
        label={t('settingsEntries.deliveryQuietHours.fields.endHour.label')}
        hint={t('settingsEntries.deliveryQuietHours.fields.endHour.hint')}
        value={form.draft.endHour}
        error={form.errors.endHour}
        defaultHour={QUIET_HOURS_DEFAULTS.endHour}
        busy={resource.busy}
        onChange={(value) => form.set('endHour', value)}
      />
      <TextField
        id="field-quietTimezone"
        label={t('settingsEntries.deliveryQuietHours.fields.timezone.label')}
        hint={t('settingsEntries.deliveryQuietHours.fields.timezone.hint')}
        value={form.draft.timezone}
        disabled={resource.busy}
        error={form.errors.timezone}
        onChange={(value) => form.set('timezone', value)}
      />
      <SaveBar dirty={form.dirty} busy={resource.busy} onSave={onSave} onReset={form.reset} />
    </>
  );
}

'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import { botFinishOptions, type BotFinishNumberKey, type BotFinishSettings } from '@/lib/bot-finish';
import { SettingsGroup } from './ui';
import { LoadGate, SelectField, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource, type SettingsResource } from './sections/settings/categories/kit/settings-store';

const PATH = '/api/bot-finish/settings';
type FlagKey = 'followupAttachEnabled' | 'finishCheckEnabled' | 'wakeEnabled';
type Resource = SettingsResource<BotFinishSettings, unknown>;
type Label = (path: string) => string;

function FlagRow({ name, settings, resource, label }: { name: FlagKey; settings: BotFinishSettings; resource: Resource; label: Label }) {
  const { t } = useI18n();
  return (
    <ToggleField
      id={`field-botFinish-${name}`}
      label={label(`fields.${name}.label`)}
      hint={label(`fields.${name}.hint`)}
      defaultText={t('settingsEntries.common.on')}
      isDefault={settings[name]}
      onRestore={() => void resource.save({ [name]: true })}
      checked={settings[name]}
      disabled={resource.busy}
      onChange={(next) => void resource.save({ [name]: next })}
    />
  );
}

function NumberRow({ name, fallback, flag, settings, resource, label }: { name: BotFinishNumberKey; fallback: number; flag: FlagKey; settings: BotFinishSettings; resource: Resource; label: Label }) {
  return (
    <SelectField
      id={`field-botFinish-${name}`}
      label={label(`fields.${name}.label`)}
      hint={label(`fields.${name}.hint`)}
      defaultText={String(fallback)}
      isDefault={settings[name] === fallback}
      onRestore={() => void resource.save({ [name]: fallback })}
      value={String(settings[name])}
      options={botFinishOptions(name, settings[name])}
      disabled={resource.busy || !settings[flag]}
      onChange={(next) => void resource.save({ [name]: Number(next) })}
    />
  );
}

const NUMBER_ROWS: Array<{ name: BotFinishNumberKey; flag: FlagKey }> = [
  { name: 'followupWindowHours', flag: 'followupAttachEnabled' },
  { name: 'maxContinuations', flag: 'finishCheckEnabled' },
  { name: 'wakeDelayMinutes', flag: 'wakeEnabled' },
  { name: 'maxWakes', flag: 'wakeEnabled' }
];
const FLAG_ROWS: FlagKey[] = ['followupAttachEnabled', 'finishCheckEnabled', 'wakeEnabled'];

function Rows({ settings, defaults, resource, label }: { settings: BotFinishSettings; defaults: BotFinishSettings; resource: Resource; label: Label }) {
  return (
    <>
      {FLAG_ROWS.map((name) => (
        <FlagRow key={name} name={name} settings={settings} resource={resource} label={label} />
      ))}
      {NUMBER_ROWS.map((row) => (
        <NumberRow key={row.name} name={row.name} flag={row.flag} fallback={defaults[row.name]} settings={settings} resource={resource} label={label} />
      ))}
      <StatusLine status={resource.status} />
    </>
  );
}

export function BotFinishSettingsCard() {
  const { t } = useI18n();
  const resource = useSettingsResource<BotFinishSettings, unknown>(PATH);
  const label: Label = (path) => t(`settingsEntries.botFinish.${path}` as MessageKey);
  const settings = resource.settings;
  return (
    <SettingsGroup id="card-bot-finish" title={label('title')} description={label('desc')}>
      <LoadGate ready={settings !== null} error={resource.loadError} onRetry={() => void resource.reload()}>
        {settings ? <Rows settings={settings} defaults={DEFAULTS} resource={resource} label={label} /> : null}
      </LoadGate>
    </SettingsGroup>
  );
}

/** Shown as the "default" hint beside each field; the daemon holds the authoritative copy. */
const DEFAULTS: BotFinishSettings = {
  followupAttachEnabled: true,
  followupWindowHours: 24,
  finishCheckEnabled: true,
  maxContinuations: 2,
  wakeEnabled: true,
  wakeDelayMinutes: 10,
  maxWakes: 3
};

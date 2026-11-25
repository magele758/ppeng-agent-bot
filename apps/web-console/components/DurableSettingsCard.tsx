'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  DURABLE_DEFAULTS,
  DURABLE_ENUM_VALUES,
  durableNumberOptions,
  type DurableEnumKey,
  type DurableNumberKey,
  type DurableSettings,
} from '@/lib/durable';
import { SettingsGroup } from './ui';
import { LoadGate, SelectField, StatusLine, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource, type SettingsResource } from './sections/settings/categories/kit/settings-store';

const PATH = '/api/durable/settings';
type Resource = SettingsResource<DurableSettings, unknown>;
type Label = (path: string) => string;

const ENUM_ROWS: DurableEnumKey[] = ['mode', 'workspaceBackend', 'chatRestartPolicy', 'waveRollbackPolicy'];
const NUMBER_ROWS: DurableNumberKey[] = ['restartLimit', 'savepointTimeoutMs'];

function EnumRow({ name, settings, resource, label }: {
  name: DurableEnumKey;
  settings: DurableSettings;
  resource: Resource;
  label: Label;
}) {
  const fallback = DURABLE_DEFAULTS[name];
  const options = DURABLE_ENUM_VALUES[name].map((value) => ({
    value,
    label: label(`options.${name}.${value}`),
  }));
  return (
    <SelectField
      id={`field-durable-${name}`}
      label={label(`fields.${name}.label`)}
      hint={label(`fields.${name}.hint`)}
      defaultText={label(`options.${name}.${fallback}`)}
      isDefault={settings[name] === fallback}
      onRestore={() => void resource.save({ [name]: fallback })}
      value={settings[name]}
      options={options}
      disabled={resource.busy}
      onChange={(next) => void resource.save({ [name]: next })}
    />
  );
}

function NumberRow({ name, settings, resource, label }: {
  name: DurableNumberKey;
  settings: DurableSettings;
  resource: Resource;
  label: Label;
}) {
  const fallback = DURABLE_DEFAULTS[name];
  return (
    <SelectField
      id={`field-durable-${name}`}
      label={label(`fields.${name}.label`)}
      hint={label(`fields.${name}.hint`)}
      defaultText={String(fallback)}
      isDefault={settings[name] === fallback}
      onRestore={() => void resource.save({ [name]: fallback })}
      value={String(settings[name])}
      options={durableNumberOptions(name, settings[name])}
      disabled={resource.busy}
      onChange={(next) => void resource.save({ [name]: Number(next) })}
    />
  );
}

function IsolateRow({ settings, resource, label }: {
  settings: DurableSettings;
  resource: Resource;
  label: Label;
}) {
  const { t } = useI18n();
  const fallback = DURABLE_DEFAULTS.isolateLongTasks;
  return (
    <ToggleField
      id="field-durable-isolateLongTasks"
      label={label('fields.isolateLongTasks.label')}
      hint={label('fields.isolateLongTasks.hint')}
      defaultText={t(fallback ? 'settingsEntries.common.on' : 'settingsEntries.common.off')}
      isDefault={settings.isolateLongTasks === fallback}
      onRestore={() => void resource.save({ isolateLongTasks: fallback })}
      checked={settings.isolateLongTasks}
      disabled={resource.busy}
      onChange={(next) => void resource.save({ isolateLongTasks: next })}
    />
  );
}

function DurableRows({ settings, resource, label }: {
  settings: DurableSettings;
  resource: Resource;
  label: Label;
}) {
  return (
    <>
      {ENUM_ROWS.map((name) => (
        <EnumRow key={name} name={name} settings={settings} resource={resource} label={label} />
      ))}
      <IsolateRow settings={settings} resource={resource} label={label} />
      {NUMBER_ROWS.map((name) => (
        <NumberRow key={name} name={name} settings={settings} resource={resource} label={label} />
      ))}
      <StatusLine status={resource.status} />
    </>
  );
}

export function DurableSettingsCard() {
  const { t } = useI18n();
  const resource = useSettingsResource<DurableSettings, unknown>(PATH);
  const label: Label = (path) => t(`settingsEntries.durable.${path}` as MessageKey);
  const settings = resource.settings;
  return (
    <SettingsGroup id="card-durable" title={label('title')} description={label('desc')}>
      <LoadGate ready={settings !== null} error={resource.loadError} onRetry={() => void resource.reload()}>
        {settings ? <DurableRows settings={settings} resource={resource} label={label} /> : null}
      </LoadGate>
    </SettingsGroup>
  );
}

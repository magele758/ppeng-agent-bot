'use client';

import { useEffect, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
import { LoadGate, SelectField, StatusLine, TextField, ToggleField } from './sections/settings/categories/kit/fields';
import { useSettingsResource, type SettingsResource } from './sections/settings/categories/kit/settings-store';

type PreferredTool = 'auto' | 'claude_code' | 'codex_exec' | 'cursor_agent';

interface ExternalAiSettings {
  enabled: boolean;
  allowInBotChats: boolean;
  preferredTool: PreferredTool;
  cursorAgentModel: string;
}

interface DetectedAgent {
  toolName: 'claude_code' | 'codex_exec' | 'cursor_agent';
  label: string;
  command: string;
  installed: boolean;
  resolvedBinary?: string;
}

interface ExternalAiEffective {
  source?: string;
  applyAt?: string;
  detectedAgents?: DetectedAgent[];
}

type LabelFn = (key: string) => string;
type Resource = SettingsResource<ExternalAiSettings, ExternalAiEffective>;

const PATH = '/api/external-ai/settings';

function DetectedAgentRow({ agent, label }: { agent: DetectedAgent; label: LabelFn }) {
  const statusText = agent.installed ? label('installed') : label('notInstalled');
  const binName = agent.resolvedBinary ?? agent.command;
  return (
    <li className="settings-field__hint">
      <strong>{agent.label}</strong> (<code>{binName}</code>): {statusText}
    </li>
  );
}

function DetectedAgentsList({ agents, label }: { agents: DetectedAgent[]; label: LabelFn }) {
  if (agents.length === 0) return null;
  return (
    <div className="settings-field" id="row-externalAi-detected">
      <div className="settings-field__text">
        <span className="settings-field__label">{label('detectedTitle')}</span>
      </div>
      <div className="settings-field__control">
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {agents.map((agent) => (
            <DetectedAgentRow key={agent.toolName} agent={agent} label={label} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function CursorModelField({ value, disabled, resource, label }: { value: string; disabled: boolean; resource: Resource; label: LabelFn }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(value);
    setError(undefined);
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length > 128 || /\s/.test(trimmed)) {
      setError(label('cursorModelInvalid'));
      return;
    }
    setError(undefined);
    if (trimmed !== value) void resource.save({ cursorAgentModel: trimmed });
  };
  return (
    <TextField
      id="field-externalAi-cursorModel"
      label={label('cursorModel')}
      hint={label('cursorModelHint')}
      placeholder={label('cursorModelPlaceholder')}
      value={draft}
      disabled={disabled}
      error={error}
      isDefault={!value}
      defaultText={label('cursorModelPlaceholder')}
      onRestore={() => void resource.save({ cursorAgentModel: '' })}
      onChange={setDraft}
      onBlur={commit}
    />
  );
}

function ExternalAiFields({ settings, agents, resource, label }: { settings: ExternalAiSettings; agents: DetectedAgent[]; resource: Resource; label: LabelFn }) {
  const { t } = useI18n();
  const options = [
    { value: 'auto' as const, label: label('preferredAuto') },
    { value: 'claude_code' as const, label: label('preferredClaude') },
    { value: 'codex_exec' as const, label: label('preferredCodex') },
    { value: 'cursor_agent' as const, label: label('preferredCursor') }
  ];
  const subDisabled = resource.busy || !settings.enabled;
  return (
    <>
      <DetectedAgentsList agents={agents} label={label} />
      <ToggleField
        id="field-externalAi-enabled"
        label={label('enabled')}
        hint={label('enabledHint')}
        checked={settings.enabled}
        disabled={resource.busy}
        defaultText={t('settingsEntries.common.off')}
        isDefault={!settings.enabled}
        onRestore={() => void resource.save({ enabled: false })}
        onChange={(enabled) => void resource.save({ enabled })}
      />
      <ToggleField
        id="field-externalAi-allowInBotChats"
        label={label('allowInBotChats')}
        hint={label('allowInBotChatsHint')}
        checked={settings.allowInBotChats}
        disabled={subDisabled}
        defaultText={t('settingsEntries.common.on')}
        isDefault={settings.allowInBotChats}
        onRestore={() => void resource.save({ allowInBotChats: true })}
        onChange={(allowInBotChats) => void resource.save({ allowInBotChats })}
      />
      <SelectField
        id="field-externalAi-preferredTool"
        label={label('preferredTool')}
        hint={label('preferredToolHint')}
        value={settings.preferredTool}
        options={options}
        disabled={subDisabled}
        defaultText={label('preferredAuto')}
        isDefault={settings.preferredTool === 'auto'}
        onRestore={() => void resource.save({ preferredTool: 'auto' })}
        onChange={(preferredTool) => void resource.save({ preferredTool })}
      />
      <CursorModelField value={settings.cursorAgentModel} disabled={subDisabled} resource={resource} label={label} />
      <StatusLine status={resource.status} />
    </>
  );
}

export function ExternalAiSettingsCard() {
  const { t } = useI18n();
  const resource = useSettingsResource<ExternalAiSettings, ExternalAiEffective>(PATH);
  const label: LabelFn = (key) => t(`settingsEntries.externalAi.${key}` as MessageKey);
  const agents = resource.effective?.detectedAgents ?? [];
  return (
    <div id="card-externalAi" className="settings-stack">
      <SettingsGroup title={label('title')} description={label('desc')}>
        <LoadGate ready={resource.settings !== null} error={resource.loadError} onRetry={() => void resource.reload()}>
          {resource.settings ? (
            <ExternalAiFields settings={resource.settings} agents={agents} resource={resource} label={label} />
          ) : null}
        </LoadGate>
      </SettingsGroup>
    </div>
  );
}

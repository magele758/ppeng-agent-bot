'use client';

import { useMemo } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { parseIntInRange } from '@/lib/settings-fields';
import { ConfigGroup, FieldLabel } from './ConfigGroup';
import { SKILL_SCOPE_OPTIONS, TASK_MODE_OPTIONS } from './TaskModePicker';
import { ExperimentRow, SettingsGroup } from './ui';
import {
  LoadGate,
  SaveBar,
  SelectField,
  SourceBadge,
  StatusLine,
  TextField,
  ToggleField
} from './sections/settings/categories/kit/fields';
import { useSettingsResource } from './sections/settings/categories/kit/settings-store';
import { useDraftForm } from './sections/settings/categories/kit/useDraftForm';

export type SteerDrainPolicy = 'next_shot_only' | 'tool_launch';
export type SteerInterruptPolicy = 'queue' | 'steer' | 'disabled';
export type KernelVariant = 'ppeng' | 'agent-loop';
export type AssemblyPreset = 'mini' | 'normal' | 'full' | 'max';
export type RepeatGuardMode = 'weak' | 'all' | 'off';

type LabTaskMode =
  | 'computer'
  | 'browser'
  | 'auto'
  | 'deep_research'
  | 'planner'
  | 'teams'
  | 'fast'
  | 'dynamic_workflow';
type LabSkillScope = 'full' | 'requested';

interface LoopSettings {
  steerDrainPolicy: SteerDrainPolicy;
  inboxOverflowCap: number | null;
  defaultTaskMode: LabTaskMode;
  defaultSkillScope: LabSkillScope;
  steerInterruptPolicy: SteerInterruptPolicy;
  kernelVariant: KernelVariant;
  assemblyPreset: AssemblyPreset;
  repeatGuard: RepeatGuardMode;
  engineEnabled?: boolean;
  updatedAt: string;
}

interface LoopEffective {
  steerDrainPolicy: SteerDrainPolicy;
  inboxOverflowCap: number | null;
  steerInterruptPolicy?: SteerInterruptPolicy;
  source: string;
}

const LOOP_PATH = '/api/loop/settings';

const DEFAULTS = {
  defaultTaskMode: 'auto',
  defaultSkillScope: 'full',
  steerInterruptPolicy: 'queue',
  steerDrainPolicy: 'next_shot_only',
  kernelVariant: 'agent-loop',
  assemblyPreset: 'max',
  inboxOverflowCap: null,
  repeatGuard: 'weak'
} as const satisfies Partial<LoopSettings>;

const INTERRUPT_POLICIES: readonly SteerInterruptPolicy[] = ['queue', 'steer', 'disabled'];
const REPEAT_GUARDS: readonly RepeatGuardMode[] = ['weak', 'all', 'off'];
const KERNELS: readonly KernelVariant[] = ['agent-loop', 'ppeng'];
const ASSEMBLIES: readonly AssemblyPreset[] = ['mini', 'normal', 'full', 'max'];
const INBOX_CAP_RANGE = { min: 0, max: 100000 } as const;
const EMPTY_ENGINE_FORM = { inboxCap: '' };

function taskModeKey(value: LabTaskMode): MessageKey {
  switch (value) {
    case 'auto':
      return 'more.taskModeAuto';
    case 'fast':
      return 'more.taskModeFast';
    case 'planner':
      return 'more.taskModePlanner';
    case 'teams':
      return 'more.taskModeTeams';
    case 'deep_research':
      return 'more.taskModeDeepResearch';
    case 'browser':
      return 'more.taskModeBrowser';
    case 'computer':
      return 'more.taskModeComputer';
    case 'dynamic_workflow':
      return 'more.taskModeDynamicWorkflow';
    default: {
      const _never: never = value;
      return _never;
    }
  }
}

function skillScopeKey(value: LabSkillScope): MessageKey {
  switch (value) {
    case 'full':
      return 'more.skillScopeFull';
    case 'requested':
      return 'more.skillScopeRequested';
    default: {
      const _never: never = value;
      return _never;
    }
  }
}

/** 对话输入框「会话设置」里的紧凑版本（沿用原有文案，由 PlayPanel 使用） */
function AgentLoopCompactFields() {
  const { t } = useI18n();
  const r = useSettingsResource<LoopSettings, LoopEffective>(LOOP_PATH);
  const settings = r.settings;
  const capSaved = settings?.inboxOverflowCap == null ? '' : String(settings.inboxOverflowCap);
  const form = useDraftForm(useMemo(() => ({ inboxCap: capSaved }), [capSaved]), EMPTY_ENGINE_FORM);

  if (!settings) return <span className="muted">{r.loadError ?? t('common.loading')}</span>;

  const commitCap = () => {
    const raw = form.draft.inboxCap.trim();
    let next: number | null = null;
    if (raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        r.setStatus({ kind: 'err', text: t('more.loopInboxCapInvalid') });
        return;
      }
      next = n === 0 ? null : n;
    }
    if (next === settings.inboxOverflowCap) return;
    void r.save({ inboxOverflowCap: next });
  };

  return (
    <ConfigGroup title={t('more.loopDefaultsGroup')} tip={t('more.loopDefaultsGroupTip')}>
      <label className="field field--inline">
        <span>{t('more.loopTaskMode')}</span>
        <select
          disabled={r.busy}
          value={settings.defaultTaskMode ?? 'auto'}
          aria-label={t('more.loopTaskMode')}
          onChange={(e) => void r.save({ defaultTaskMode: e.target.value as LabTaskMode })}
        >
          {TASK_MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(taskModeKey(opt.value))}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--inline">
        <span>{t('more.loopSkillScope')}</span>
        <select
          disabled={r.busy}
          value={settings.defaultSkillScope ?? 'full'}
          aria-label={t('more.loopSkillScopeAria')}
          onChange={(e) => void r.save({ defaultSkillScope: e.target.value as LabSkillScope })}
        >
          {SKILL_SCOPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(skillScopeKey(opt.value))}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--inline">
        <FieldLabel tip={t('more.loopKernelTip')}>{t('more.loopKernelLabel')}</FieldLabel>
        <select
          disabled={r.busy}
          value={settings.kernelVariant ?? 'agent-loop'}
          aria-label={t('more.loopKernelAria')}
          onChange={(e) => void r.save({ kernelVariant: e.target.value as KernelVariant })}
        >
          <option value="ppeng">{t('more.loopKernelPpeng')}</option>
          <option value="agent-loop">{t('more.loopKernelAgentLoop')}</option>
        </select>
      </label>
      <label className="field field--inline">
        <FieldLabel tip={t('more.loopAssemblyTip')}>{t('more.loopAssemblyLabel')}</FieldLabel>
        <select
          disabled={r.busy || (settings.kernelVariant ?? 'agent-loop') === 'ppeng'}
          value={settings.assemblyPreset ?? 'max'}
          aria-label={t('more.loopAssemblyAria')}
          onChange={(e) => void r.save({ assemblyPreset: e.target.value as AssemblyPreset })}
        >
          <option value="mini">{t('more.loopAssemblyMini')}</option>
          <option value="normal">{t('more.loopAssemblyNormal')}</option>
          <option value="full">{t('more.loopAssemblyFull')}</option>
          <option value="max">{t('more.loopAssemblyMax')}</option>
        </select>
      </label>
      <label className="field field--inline">
        <FieldLabel tip={t('more.loopInboxCapTip')}>{t('more.loopInboxCap')}</FieldLabel>
        <input
          type="number"
          min={0}
          step={1}
          disabled={r.busy}
          value={form.draft.inboxCap}
          placeholder={t('more.loopInboxUnlimited')}
          aria-label={t('more.loopInboxCap')}
          onChange={(e) => form.set('inboxCap', e.target.value)}
          onBlur={() => commitCap()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      {r.status?.kind === 'ok' ? (
        <p className="muted" style={{ fontSize: '0.75rem', margin: '4px 0 0' }}>
          {t('more.savedNoRestart')}
        </p>
      ) : null}
      {r.status?.kind === 'err' ? (
        <p style={{ color: 'var(--danger, #c44)', fontSize: '0.75rem', margin: '4px 0 0' }}>{r.status.text}</p>
      ) : null}
    </ConfigGroup>
  );
}

function AgentLoopBasicCard() {
  const { t } = useI18n();
  const r = useSettingsResource<LoopSettings, LoopEffective>(LOOP_PATH);
  const s = r.settings;
  const base = 'settingsEntries.agentLoop';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);

  const taskModeOptions = TASK_MODE_OPTIONS.map((o) => ({ value: o.value, label: label(`options.taskMode.${o.value}.label`) }));
  const scopeOptions = SKILL_SCOPE_OPTIONS.map((o) => ({ value: o.value, label: label(`options.skillScope.${o.value}.label`) }));
  const interruptOptions = INTERRUPT_POLICIES.map((v) => ({ value: v, label: label(`options.interrupt.${v}.label`) }));
  const repeatGuardOptions = REPEAT_GUARDS.map((v) => ({
    value: v,
    label: label(`options.repeatGuard.${v}.label`)
  }));
  const repeatGuard = s?.repeatGuard ?? 'weak';

  return (
    <SettingsGroup id="card-agent-loop" title={t(`${base}.title` as MessageKey)} description={label('desc')}>
      <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
        {s ? (
          <>
            <SelectField
              id="field-defaultTaskMode"
              label={label('fields.taskMode.label')}
              hint={`${label('fields.taskMode.hint')} ${label(`options.taskMode.${s.defaultTaskMode ?? 'auto'}.desc`)}`}
              value={s.defaultTaskMode ?? 'auto'}
              options={taskModeOptions}
              disabled={r.busy}
              defaultText={label(`options.taskMode.${DEFAULTS.defaultTaskMode}.label`)}
              isDefault={(s.defaultTaskMode ?? 'auto') === DEFAULTS.defaultTaskMode}
              onRestore={() => void r.save({ defaultTaskMode: DEFAULTS.defaultTaskMode })}
              onChange={(defaultTaskMode) => void r.save({ defaultTaskMode })}
            />
            <SelectField
              id="field-defaultSkillScope"
              label={label('fields.skillScope.label')}
              hint={`${label('fields.skillScope.hint')} ${label(`options.skillScope.${s.defaultSkillScope ?? 'full'}.desc`)}`}
              value={s.defaultSkillScope ?? 'full'}
              options={scopeOptions}
              disabled={r.busy}
              defaultText={label(`options.skillScope.${DEFAULTS.defaultSkillScope}.label`)}
              isDefault={(s.defaultSkillScope ?? 'full') === DEFAULTS.defaultSkillScope}
              onRestore={() => void r.save({ defaultSkillScope: DEFAULTS.defaultSkillScope })}
              onChange={(defaultSkillScope) => void r.save({ defaultSkillScope })}
            />
            <SelectField
              id="field-repeatGuard"
              label={label('fields.repeatGuard.label')}
              hint={`${label('fields.repeatGuard.hint')} ${label(`options.repeatGuard.${repeatGuard}.desc`)}`}
              value={repeatGuard}
              options={repeatGuardOptions}
              disabled={r.busy}
              defaultText={label(`options.repeatGuard.${DEFAULTS.repeatGuard}.label`)}
              isDefault={repeatGuard === DEFAULTS.repeatGuard}
              onRestore={() => void r.save({ repeatGuard: DEFAULTS.repeatGuard })}
              onChange={(repeatGuard) => void r.save({ repeatGuard })}
            />
            <SelectField
              id="field-steerInterrupt"
              label={label('fields.interrupt.label')}
              hint={`${label('fields.interrupt.hint')} ${label(`options.interrupt.${s.steerInterruptPolicy ?? 'queue'}.desc`)}`}
              value={s.steerInterruptPolicy ?? 'queue'}
              options={interruptOptions}
              disabled={r.busy}
              defaultText={label(`options.interrupt.${DEFAULTS.steerInterruptPolicy}.label`)}
              isDefault={(s.steerInterruptPolicy ?? 'queue') === DEFAULTS.steerInterruptPolicy}
              onRestore={() => void r.save({ steerInterruptPolicy: DEFAULTS.steerInterruptPolicy })}
              onChange={(steerInterruptPolicy) => void r.save({ steerInterruptPolicy })}
            />
          </>
        ) : null}
        <StatusLine status={r.status} />
      </LoadGate>
    </SettingsGroup>
  );
}

export function AgentLoopEngineSettingsCard() {
  const { t } = useI18n();
  const r = useSettingsResource<LoopSettings, LoopEffective>(LOOP_PATH);
  const s = r.settings;
  const base = 'settingsEntries.agentLoopEngine';
  const label = (path: string) => t(`${base}.${path}` as MessageKey);
  const capSaved = s?.inboxOverflowCap == null ? '' : String(s.inboxOverflowCap);
  const form = useDraftForm(useMemo(() => ({ inboxCap: capSaved }), [capSaved]), EMPTY_ENGINE_FORM);

  const kernelOptions = KERNELS.map((v) => ({ value: v, label: label(`options.kernel.${v}`) }));
  const assemblyOptions = ASSEMBLIES.map((v) => ({ value: v, label: label(`options.assembly.${v}`) }));
  const kernel = s?.kernelVariant ?? 'agent-loop';

  const rangeError = () => t('settingsEntries.common.invalidRange', INBOX_CAP_RANGE);
  const parseCap = (): { ok: true; value: number | null } | { ok: false } => {
    if (form.draft.inboxCap.trim() === '') return { ok: true, value: null };
    const parsed = parseIntInRange(form.draft.inboxCap, INBOX_CAP_RANGE.min, INBOX_CAP_RANGE.max);
    return parsed.ok ? { ok: true, value: parsed.value === 0 ? null : parsed.value } : { ok: false };
  };

  const submit = async () => {
    const cap = parseCap();
    if (!cap.ok) {
      form.setError('inboxCap', rangeError());
      return;
    }
    await r.save({ inboxOverflowCap: cap.value });
  };

  return (
    <LoadGate ready={s !== null} error={r.loadError} onRetry={() => void r.reload()}>
      {s ? (
        <ExperimentRow
          id="card-agent-loop-engine"
          switchId="agentLoopEngine"
          title={t(`${base}.title` as MessageKey)}
          description={label('desc')}
          on={s.engineEnabled !== false}
          busy={r.busy}
          onChange={(engineEnabled) => void r.save({ engineEnabled })}
        >
          <>
            <ToggleField
              id="field-steerDrain"
              label={label('fields.drain.label')}
              hint={label('fields.drain.hint')}
              checked={s.steerDrainPolicy === 'tool_launch'}
              disabled={r.busy}
              defaultText={t('settingsEntries.common.off')}
              isDefault={s.steerDrainPolicy === DEFAULTS.steerDrainPolicy}
              onRestore={() => void r.save({ steerDrainPolicy: DEFAULTS.steerDrainPolicy })}
              onChange={(on) => void r.save({ steerDrainPolicy: on ? 'tool_launch' : 'next_shot_only' })}
            />
            <SelectField
              id="field-kernelVariant"
              label={label('fields.kernel.label')}
              hint={label('fields.kernel.hint')}
              value={kernel}
              options={kernelOptions}
              disabled={r.busy}
              defaultText={label('defaults.kernel')}
              isDefault={kernel === DEFAULTS.kernelVariant}
              onRestore={() => void r.save({ kernelVariant: DEFAULTS.kernelVariant })}
              onChange={(kernelVariant) => void r.save({ kernelVariant })}
            />
            <SelectField
              id="field-assemblyPreset"
              label={label('fields.assembly.label')}
              hint={kernel === 'ppeng' ? label('fields.assembly.ppengDisabled') : label('fields.assembly.hint')}
              value={s.assemblyPreset ?? 'max'}
              options={assemblyOptions}
              disabled={r.busy || kernel === 'ppeng'}
              defaultText={label('defaults.assembly')}
              isDefault={(s.assemblyPreset ?? 'max') === DEFAULTS.assemblyPreset}
              onRestore={() => void r.save({ assemblyPreset: DEFAULTS.assemblyPreset })}
              onChange={(assemblyPreset) => void r.save({ assemblyPreset })}
            />
            <TextField
              id="field-inboxCap"
              type="number"
              inputMode="numeric"
              label={label('fields.inboxCap.label')}
              hint={label('fields.inboxCap.hint')}
              placeholder={label('fields.inboxCap.placeholder')}
              value={form.draft.inboxCap}
              disabled={r.busy}
              error={form.errors.inboxCap}
              defaultText={label('defaults.inboxCap')}
              isDefault={form.draft.inboxCap.trim() === ''}
              onRestore={() => form.set('inboxCap', '')}
              onChange={(v) => form.set('inboxCap', v)}
              onBlur={() => {
                if (!parseCap().ok) form.setError('inboxCap', rangeError());
              }}
            />
            <SaveBar dirty={form.dirty} busy={r.busy} onSave={() => void submit()} onReset={form.reset} />
          </>
        </ExperimentRow>
      ) : null}
      <StatusLine status={r.status} />
      {r.effective ? <SourceBadge source={r.effective.source} /> : null}
    </LoadGate>
  );
}

export function AgentLoopSettingsCard({ compact = false }: { compact?: boolean }) {
  return compact ? <AgentLoopCompactFields /> : <AgentLoopBasicCard />;
}

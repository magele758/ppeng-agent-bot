'use client';

import { FieldLabel } from './ConfigGroup';
import { useI18n, type MessageKey } from '@/lib/i18n';

export const TASK_MODE_OPTIONS = [
  { value: 'auto' },
  { value: 'fast' },
  { value: 'planner' },
  { value: 'teams' },
  { value: 'deep_research' },
  { value: 'browser' },
  { value: 'computer' },
  { value: 'dynamic_workflow' }
] as const;

export const SKILL_SCOPE_OPTIONS = [{ value: 'full' }, { value: 'requested' }] as const;

export type LabTaskMode = (typeof TASK_MODE_OPTIONS)[number]['value'];
export type LabSkillScope = 'full' | 'requested';

function taskModeKey(value: LabTaskMode): MessageKey {
  switch (value) {
    case 'auto':
      return 'play.taskMode.auto';
    case 'fast':
      return 'play.taskMode.fast';
    case 'planner':
      return 'play.taskMode.planner';
    case 'teams':
      return 'play.taskMode.teams';
    case 'deep_research':
      return 'play.taskMode.deepResearch';
    case 'browser':
      return 'play.taskMode.browser';
    case 'computer':
      return 'play.taskMode.computer';
    case 'dynamic_workflow':
      return 'play.taskMode.dynamicWorkflow';
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

function skillScopeKey(value: LabSkillScope): MessageKey {
  switch (value) {
    case 'full':
      return 'play.skillScope.full';
    case 'requested':
      return 'play.skillScope.requested';
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

export function TaskModePicker({
  mode,
  skillScope,
  bound,
  disabled,
  onModeChange,
  onSkillScopeChange
}: {
  mode: LabTaskMode;
  skillScope: LabSkillScope;
  bound: boolean;
  disabled?: boolean;
  onModeChange: (mode: LabTaskMode) => void;
  onSkillScopeChange?: (scope: LabSkillScope) => void;
}) {
  const { t } = useI18n();
  const locked = disabled || bound;
  return (
    <>
      <label className="session-settings__field">
        <FieldLabel tip={t('play.taskMode.tip')}>{t('play.taskMode.label')}</FieldLabel>
        <select
          value={mode}
          disabled={locked}
          title={bound ? t('play.taskMode.bound') : t('play.taskMode.how')}
          aria-label={t('play.taskMode.label')}
          onChange={(e) => onModeChange(e.target.value as LabTaskMode)}
        >
          {TASK_MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(taskModeKey(opt.value))}
            </option>
          ))}
        </select>
      </label>
      {onSkillScopeChange ? (
        <label className="session-settings__field">
          <FieldLabel tip={t('play.skillScope.tip')}>{t('play.skillScope.label')}</FieldLabel>
          <select
            value={skillScope}
            disabled={disabled}
            title={t('play.skillScope.what')}
            aria-label={t('play.skillScope.label')}
            onChange={(e) => onSkillScopeChange(e.target.value as LabSkillScope)}
          >
            {SKILL_SCOPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(skillScopeKey(opt.value))}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}

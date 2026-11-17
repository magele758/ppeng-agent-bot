'use client';

import type { ReactNode, RefObject } from 'react';
import type { usePlayChat } from '../../usePlayChat';
import { useI18n } from '@/lib/i18n';
import { formatHash } from '@/lib/nav';
import type { AutonomyLevel } from '@/lib/session-chrome';
import { FieldLabel } from '../../ConfigGroup';
import { QueryQueue } from '../../QueryQueue';
import { TaskModePicker } from '../../TaskModePicker';

export type ExecPreset = 'chat' | 'task' | 'orchestrator';

type PlayChat = ReturnType<typeof usePlayChat>;

const EXEC_PRESETS: ExecPreset[] = ['chat', 'task', 'orchestrator'];

function execPresetLabel(preset: ExecPreset): 'play.assembly.chat' | 'play.assembly.task' | 'play.assembly.orchestrator' {
  if (preset === 'task') return 'play.assembly.task';
  if (preset === 'orchestrator') return 'play.assembly.orchestrator';
  return 'play.assembly.chat';
}

function segmentClass(selected: boolean): string | undefined {
  if (selected) return 'is-selected';
  return undefined;
}

function commitGoal(sessionId: string | null, draft: string, committed: string, save: (next: string) => void) {
  if (!sessionId) return;
  const next = draft.trim();
  if (next !== committed.trim()) save(next);
}

function GoalConditionField({
  value,
  committed,
  sessionId,
  onChange,
  onCommit
}: {
  value: string;
  committed: string;
  sessionId: string | null;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="session-settings__field session-settings__field--wide">
      <FieldLabel tip={t('play.settings.goalTip')}>{t('play.strategy.goal')}</FieldLabel>
      <input
        type="text"
        className="input-compact"
        placeholder={t('chatPage.goalPlaceholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => commitGoal(sessionId, value, committed, onCommit)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onCommit(value);
        }}
        aria-label={t('play.strategy.goalAria')}
      />
    </label>
  );
}

function ExecModeSegments({ value, disabled, onChange }: { value: ExecPreset; disabled: boolean; onChange: (preset: ExecPreset) => void }) {
  const { t } = useI18n();
  return (
    <div role="group" className="session-settings__seg" aria-label={t('play.assembly.execMode')}>
      {EXEC_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          aria-pressed={value === preset}
          className={segmentClass(value === preset)}
          disabled={disabled}
          onClick={() => onChange(preset)}
        >
          {t(execPresetLabel(preset))}
        </button>
      ))}
    </div>
  );
}

export interface SessionSettingsPanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  chat: PlayChat;
  botSurface: boolean;
  botLocked: boolean;
  chatRunning: boolean;
  selectedSessionId: string | null;
  goalCommitted: string;
  execPreset: ExecPreset;
  agentSelectValue: string;
  agentOptions: ReactNode;
  onExecPreset: (preset: ExecPreset) => void;
  onSupportAgent: (agentId: string) => void;
  onNavigate: () => void;
}

/** 对话输入区的「会话设置」面板：常用项在前，其余收进「高级」；全局设置只给设置页链接。 */
export function SessionSettingsPanel({
  panelRef,
  chat,
  botSurface,
  botLocked,
  chatRunning,
  selectedSessionId,
  goalCommitted,
  execPreset,
  agentSelectValue,
  agentOptions,
  onExecPreset,
  onSupportAgent,
  onNavigate
}: SessionSettingsPanelProps) {
  const { t } = useI18n();
  const showQueue = chatRunning || chat.steerInbox.length > 0;
  const showOptionalTools = chat.optionalToolGroupsFeature && chat.optionalToolCatalog.length > 0;

  return (
    <div id="composerConfigPanel" ref={panelRef} className="composer-config-panel session-settings" role="dialog" aria-label={t('play.settings.title')}>
      <header className="session-settings__head">
        <h3 className="session-settings__title">{t('play.settings.title')}</h3>
        <p className="session-settings__hint">{t('play.settings.hint')}</p>
      </header>

      {showQueue ? (
        <QueryQueue
          inbox={chat.steerInbox}
          running={chatRunning}
          busy={chat.steerPolicyBusy}
          composeMode={chat.queryExecMode}
          onComposeModeChange={chat.setQueryExecMode}
          onUpdateText={(id, text) => chat.updateSteerItem(id, text)}
          onDelete={(id) => chat.dropSteerItem(id)}
          onSetMode={(id, mode) => chat.setSteerItemMode(id, mode)}
        />
      ) : null}

      <div className="session-settings__fields">
        <div className="session-settings__field session-settings__field--wide">
          <FieldLabel tip={t('play.settings.execModeTip')}>{t('play.assembly.execMode')}</FieldLabel>
          <ExecModeSegments value={execPreset} disabled={botSurface} onChange={onExecPreset} />
        </div>

        <label className="session-settings__field">
          <FieldLabel tip={t('play.settings.agentTip')}>Agent</FieldLabel>
          <select
            id="agentSelect"
            value={botLocked ? chat.agentId : agentSelectValue}
            disabled={botLocked}
            aria-label="Agent"
            title={botLocked ? t('play.assembly.agentLocked') : undefined}
            onChange={(e) => onSupportAgent(e.target.value)}
          >
            {botLocked ? <option value={chat.agentId}>{chat.agentId} · Bot</option> : agentOptions}
            </select>
          </label>

          <GoalConditionField
            value={chat.goalDraft}
            committed={goalCommitted}
            sessionId={selectedSessionId}
            onChange={chat.setGoalDraft}
            onCommit={(next) => void chat.saveGoalCondition(next)}
          />

        {botSurface ? null : (
          <label className="session-settings__field">
            <FieldLabel tip={t('play.strategy.autonomyTip')}>{t('play.autonomy.label')}</FieldLabel>
            <select
              value={chat.autonomyLevel}
              onChange={(e) => void chat.saveAutonomy(e.target.value as AutonomyLevel)}
              aria-label={t('play.autonomy.label')}
            >
              <option value="supervised">{t('play.autonomy.supervised')}</option>
              <option value="balanced">{t('play.autonomy.balanced')}</option>
              <option value="autonomous">{t('play.autonomy.autonomous')}</option>
            </select>
          </label>
        )}
      </div>

      {botSurface ? (
        <>
          <a
            className="session-settings__link"
            href={formatHash({ section: 'agents', sub: 'bots' })}
            onClick={onNavigate}
          >
            {t('play.settings.manageBots')}
          </a>
        </>
      ) : null}

      <details className="session-settings__advanced">
        <summary>{t('play.settings.advanced')}</summary>
        <div className="session-settings__fields">
          <TaskModePicker
            mode={chat.taskMode}
            skillScope={chat.skillScope}
            bound={chat.taskModeBound}
            disabled={botSurface}
            onModeChange={(next) => void chat.saveTaskMode(next)}
            onSkillScopeChange={(next) => void chat.saveSkillScope(next)}
          />
          <label className="session-settings__field">
            <FieldLabel tip={t('play.strategy.orchTip')}>{t('play.strategy.orch')}</FieldLabel>
            <select
              value={chat.orchestrationEngine}
              disabled={botSurface || chat.taskModeBound}
              title={
                chat.taskModeBound
                  ? t('play.strategy.orchBound')
                  : botSurface
                    ? t('play.strategy.orchBot')
                    : t('play.strategy.orchPtc')
              }
              onChange={(e) => void chat.saveOrchestrationEngine(e.target.value as 'legacy' | 'ptc')}
              aria-label={t('play.strategy.orchAria')}
            >
              <option value="legacy">{t('play.strategy.legacy')}</option>
              <option value="ptc">{t('play.strategy.ptc')}</option>
            </select>
          </label>
        </div>
        {showOptionalTools ? (
          <fieldset className="session-settings__tools optional-tool-groups">
            <legend>{t('play.feedback.extraTools')}</legend>
            {chat.optionalToolCatalog.map((g) => (
              <label key={g.id} className="toggle" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={chat.enabledOptionalGroupIds.includes(g.id)}
                  onChange={(e) => void chat.toggleOptionalGroup(g.id, e.target.checked)}
                />
                <span>
                  <strong>{g.title}</strong>
                  {g.description ? <span className="muted"> — {g.description}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </details>

      <footer className="session-settings__foot">
        <a
          className="session-settings__link"
          href={formatHash({ section: 'settings', sub: 'behavior' })}
          onClick={onNavigate}
        >
          {t('play.settings.moreGlobal')}
        </a>
      </footer>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  BOT_PERMISSION_MODES,
  needsBypassConfirm,
  parseBotPermissionMode,
  type BotPermissionMode
} from '@/lib/bot-permission';
import { BotBypassRevert, BotPolicyWarnings } from './BotPolicyFollowups';
import { ConfigGroup, FieldLabel } from './ConfigGroup';
import { Disclosure } from './sections/agents/Disclosure';

const TURN_CHOICES = [0, 24, 48, 96] as const;

export function BotPolicySettings({
  botId,
  maxTurns,
  permissionMode,
  allowedTools,
  allowedSkills,
  allowlistsCollapsed = false,
  onSavePermission,
  onSave
}: {
  botId: string | null;
  maxTurns: number;
  permissionMode: BotPermissionMode;
  onSavePermission: (mode: BotPermissionMode, opts?: { confirmBypass?: boolean }) => Promise<void>;
  allowedTools: string[];
  allowedSkills: string[];
  /** 把工具/技能名单收进「高级」折叠区（Bots 管理页使用） */
  allowlistsCollapsed?: boolean;
  onSave: (patch: {
    maxTurns?: number;
    allowedTools?: string[];
    allowedSkills?: string[];
  }) => Promise<{ warnings?: unknown } | void>;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>(allowedTools);
  const [skillCatalog, setSkillCatalog] = useState<string[]>([]);
  const [skillDraft, setSkillDraft] = useState<string[]>(allowedSkills);
  const [pendingBypass, setPendingBypass] = useState(false);
  const [warningsNonce, setWarningsNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toolsKey = allowedTools.join('\n');
  const skillsKey = allowedSkills.join('\n');

  useEffect(() => {
    setDraft(toolsKey ? toolsKey.split('\n') : []);
  }, [toolsKey]);

  useEffect(() => {
    setSkillDraft(skillsKey ? skillsKey.split('\n') : []);
  }, [skillsKey]);

  useEffect(() => {
    let cancelled = false;
    void api('/api/tools')
      .then((data) => {
        if (cancelled) return;
        const tools = (data as { tools?: Array<{ name?: string }> }).tools ?? [];
        setCatalog(
          tools
            .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
            .filter((name) => name.length > 0)
        );
        setErr(null);
      })
      .catch(() => {
        if (!cancelled) setErr(t('play.botPolicy.catalogFailed'));
      });
    void api('/api/skills')
      .then((data) => {
        if (cancelled) return;
        const skills = (data as { skills?: Array<{ name?: string }> }).skills ?? [];
        setSkillCatalog(
          skills
            .map((skill) => (typeof skill.name === 'string' ? skill.name : ''))
            .filter((name) => name.length > 0)
        );
      })
      .catch(() => {
        if (!cancelled) setErr(t('play.botPolicy.skillCatalogFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const turnValue = maxTurns === 24 || maxTurns === 48 || maxTurns === 96 ? maxTurns : 0;
  const optionNames = [...new Set([...catalog, ...draft])];
  const skillOptionNames = [...new Set([...skillCatalog, ...skillDraft])];

  const saveTurns = async (next: number) => {
    if (!botId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ maxTurns: next });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePermission = async (next: BotPermissionMode, confirmBypass = false) => {
    if (!botId || busy) return;
    setPendingBypass(false);
    setBusy(true);
    setErr(null);
    try {
      await onSavePermission(next, confirmBypass ? { confirmBypass: true } : undefined);
      setWarningsNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickPermission = (next: BotPermissionMode) => {
    if (next === permissionMode) {
      setPendingBypass(false);
      return;
    }
    if (needsBypassConfirm(permissionMode, next)) {
      setPendingBypass(true);
      return;
    }
    void savePermission(next);
  };

  const removeStale = async (next: string[]) => {
    if (!botId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ allowedTools: next });
      setWarningsNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAllowlists = async () => {
    if (!botId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ allowedTools: draft, allowedSkills: skillDraft });
      setWarningsNonce((n) => n + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const allowlistFields = (
    <>
      <label className="field field--inline field--grow">
        <span>{t('play.botPolicy.allowedTools')}</span>
        <select
          multiple
          className="bot-policy-tools"
          aria-label={t('play.botPolicy.allowedToolsAria')}
          value={draft}
          disabled={!botId || busy}
          onChange={(e) => {
            setDraft(Array.from(e.target.selectedOptions).map((option) => option.value));
          }}
        >
          {optionNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="bot-cron-card__meta">{t('play.botPolicy.allowedToolsHint')}</p>
      <label className="field field--inline field--grow">
        <span>{t('play.botPolicy.allowedSkills')}</span>
        <select
          multiple
          className="bot-policy-tools"
          aria-label={t('play.botPolicy.allowedSkillsAria')}
          value={skillDraft}
          disabled={!botId || busy}
          onChange={(e) => {
            setSkillDraft(Array.from(e.target.selectedOptions).map((option) => option.value));
          }}
        >
          {skillOptionNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p className="bot-cron-card__meta">{t('play.botPolicy.allowedSkillsHint')}</p>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!botId || busy}
        onClick={() => void saveAllowlists()}
      >
        {busy ? t('play.botPolicy.saving') : t('play.botPolicy.saveAllowlists')}
      </button>
    </>
  );

  return (
    <ConfigGroup title={t('play.botPolicy.title')} tip={t('play.botPolicy.tip')}>
      {err ? <p className="bot-cron-panel__err">{err}</p> : null}
      <label className="field field--inline">
        <FieldLabel tip={t('play.botPolicy.permissionTip')}>
          {t('play.botPolicy.permission')}
        </FieldLabel>
        <select
          value={permissionMode}
          disabled={!botId || busy}
          aria-label={t('play.botPolicy.permissionAria')}
          onChange={(e) => pickPermission(parseBotPermissionMode(e.target.value))}
        >
          {BOT_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode} aria-label={t(`play.botPolicy.permissionMode.${mode}`)}>
              {t(`play.botPolicy.permissionMode.${mode}`)}
            </option>
          ))}
        </select>
      </label>
      {permissionMode === 'bypass' ? (
        <p className="bot-cron-panel__err" role="status">
          {t('play.botPolicy.bypassActive')}
        </p>
      ) : null}
      <BotBypassRevert
        permissionMode={permissionMode}
        disabled={!botId || busy}
        onRevert={() => savePermission('auto')}
      />
      {pendingBypass ? (
        <div className="bot-policy-confirm" role="alertdialog" aria-label={t('play.botPolicy.bypassConfirmTitle')}>
          <strong>{t('play.botPolicy.bypassConfirmTitle')}</strong>
          <p>{t('play.botPolicy.bypassConfirmBody')}</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void savePermission('bypass', true)}
          >
            {t('play.botPolicy.bypassConfirm')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setPendingBypass(false)}
          >
            {t('play.botPolicy.bypassCancel')}
          </button>
        </div>
      ) : null}
      <label className="field field--inline">
        <FieldLabel>{t('play.botPolicy.maxTurns')}</FieldLabel>
        <select
          value={turnValue}
          disabled={!botId || busy}
          aria-label={t('play.botPolicy.maxTurnsAria')}
          onChange={(e) => void saveTurns(Number(e.target.value))}
        >
          {TURN_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 0 ? t('play.botPolicy.unlimitedTurns') : choice}
            </option>
          ))}
        </select>
      </label>
      <BotPolicyWarnings
        botId={botId}
        refreshKey={`${toolsKey}|${warningsNonce}`}
        allowedTools={allowedTools}
        disabled={!botId || busy}
        onRemoveStale={removeStale}
        onKeepBypass={() => savePermission('bypass', true)}
      />
      {allowlistsCollapsed ? (
        <Disclosure label={t('agents.bots.sectionAllowlists')}>
          <p className="bot-cron-card__meta">{t('agents.bots.allowlistsHint')}</p>
          {allowlistFields}
        </Disclosure>
      ) : (
        allowlistFields
      )}
    </ConfigGroup>
  );
}

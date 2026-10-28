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

const TURN_CHOICES = [0, 24, 48, 96] as const;

export function BotPolicySettings({
  botId,
  maxTurns,
  permissionMode,
  allowedTools,
  onlyTools = false,
  onSavePermission,
  onSave
}: {
  botId: string | null;
  maxTurns: number;
  permissionMode: BotPermissionMode;
  onSavePermission: (mode: BotPermissionMode, opts?: { confirmBypass?: boolean }) => Promise<void>;
  allowedTools: string[];
  onlyTools?: boolean;
  onSave: (patch: {
    maxTurns?: number;
    allowedTools?: string[];
  }) => Promise<{ warnings?: unknown } | void>;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>(allowedTools);
  const [pendingBypass, setPendingBypass] = useState(false);
  const [warningsNonce, setWarningsNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toolsKey = allowedTools.join('\n');

  useEffect(() => {
    setDraft(toolsKey ? toolsKey.split('\n') : []);
  }, [toolsKey]);

  useEffect(() => {
    if (!onlyTools) return;
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
    return () => {
      cancelled = true;
    };
  }, [t, onlyTools]);

  const turnValue = maxTurns === 24 || maxTurns === 48 || maxTurns === 96 ? maxTurns : 0;
  const optionNames = [...new Set([...catalog, ...draft])];

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
      await onSave({ allowedTools: draft });
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
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={!botId || busy}
        onClick={() => void saveAllowlists()}
      >
        {busy ? t('play.botPolicy.saving') : t('botSettings.saveTools')}
      </button>
    </>
  );

  if (onlyTools) return <ConfigGroup title={t('botSettings.tools')} tip={t('botSettings.toolsHint')}><p>{t('botSettings.toolsHint')}</p><ToolDraftStatus error={err} dirty={draft.join('\n')!==toolsKey}/>{allowlistFields}      <BotPolicyWarnings
        botId={botId}
        refreshKey={`${toolsKey}|${warningsNonce}`}
        allowedTools={allowedTools}
        disabled={!botId || busy}
        onRemoveStale={removeStale}
        onKeepBypass={() => savePermission('bypass', true)}
      />
</ConfigGroup>;
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
      <p>{t('botSettings.runHint')}</p>
    </ConfigGroup>
  );
}

function ToolDraftStatus({error, dirty}: {error: string | null; dirty: boolean}) {
  const {t} = useI18n();
  return <>{error && <p role="alert">{error}</p>}{dirty && <p>{t('botSettings.unsaved')}</p>}</>;
}

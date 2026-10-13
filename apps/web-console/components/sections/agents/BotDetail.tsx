'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { readBotSettings, type BotSettingsSnapshot } from '@/lib/bot-policy';
import type { BotPermissionMode } from '@/lib/bot-permission';
import { catalogToPickerOptions, type ModelProvidersResponse, type ModelRef } from '@/lib/model-providers';
import type { BotInfo } from '@/lib/types';
import { BotRuntimeControl } from '../../bot-work/BotLimits';
import { BotMemory } from '../../bot-work/BotMemory';
import { BotHistory } from '../../bot-work/BotHistory';
import { BotConnections } from '../../bot-work/BotConnections';
import { BotCronPanel } from '../../BotCronPanel';
import { BotModelSetting } from '../../BotModelSetting';
import { BotPolicySettings } from '../../BotPolicySettings';
import { SettingsGroup } from '../../ui';

interface BotDetailProps {
  bot: BotInfo;
  onOpenChat: (bot: BotInfo) => void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function BotDetail({ bot, onOpenChat }: BotDetailProps) {
  const { t } = useI18n();
  const [sessionId,setSessionId]=useState(bot.canonicalSessionId);
  const [settings, setSettings] = useState<BotSettingsSnapshot | null>(null);
  const [catalog, setCatalog] = useState<ModelProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const opened=await api(`/api/bots/${encodeURIComponent(bot.id)}/open`,{method:'POST'}) as {session:{id:string}};
      setSessionId(opened.session.id);
      const data = (await api(`/api/sessions/${encodeURIComponent(opened.session.id)}?includeMessages=false`)) as {
        session?: { metadata?: Record<string, unknown> };
      };
      setSettings(readBotSettings(data.session?.metadata));
      setError(null);
    } catch (e) {
      setError(t('agents.bots.settingsFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [bot.canonicalSessionId, t]);

  useEffect(() => {
    setSettings(null);
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void api('/api/model-providers')
      .then((data) => {
        if (!cancelled) setCatalog(data as ModelProvidersResponse);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patchBot = useCallback(
    async (patch: Record<string, unknown>) => {
      const result = (await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch)
      })) as { warnings?: unknown };
      await load();
      return result;
    },
    [bot.id, load]
  );

  const savePermission = useCallback(
    async (mode: BotPermissionMode, opts?: { confirmBypass?: boolean }) => {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          permissionMode: mode,
          ...(mode === 'bypass' && opts?.confirmBypass ? { confirmBypass: true } : {})
        })
      });
      await load();
    },
    [sessionId, load]
  );

  const saveModel = useCallback(
    async (next: ModelRef | null) => {
      await patchBot({ modelOverride: next });
    },
    [patchBot]
  );

  return (
    <section className="ag-panel" aria-label={t('agents.bots.detailTitle')} id="botDetail" data-testid="bot-detail">
      <div className="ag-panel__head">
        <div>
          <h3 className="ag-panel__title">{bot.name}</h3>
          {bot.title && bot.title !== bot.name ? <p className="ag-panel__lead">{bot.title}</p> : null}
        </div>
        <div className="ag-panel__actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenChat(bot)}>
            {t('agents.bots.openChat')}
          </button>
        </div>
      </div>
      <div className="ag-chips">
        <span className="chip chip-muted">{t('agents.bots.agentChip', { agent: bot.agentId })}</span>
      </div>
      {bot.description ? <p className="ag-panel__lead">{bot.description}</p> : null}

      {error ? (
        <p className="ag-status ag-status--err" role="alert">
          {error}
        </p>
      ) : null}
      {!settings && !error ? <p className="ag-panel__lead">{t('agents.bots.loadingSettings')}</p> : null}
      <BotRuntimeControl botId={bot.id}/>
      <BotHistory sessionId={sessionId} />
      <BotMemory botId={bot.id} sessionId={sessionId}/>
      <BotConnections botId={bot.id} />
      {settings ? (
        <>
          <BotPolicySettings
            botId={bot.id}
            maxTurns={settings.maxTurns}
            permissionMode={settings.permissionMode}
            onSavePermission={savePermission}
            allowedTools={settings.allowedTools}
            allowedSkills={settings.allowedSkills}
            allowlistsCollapsed
            onSave={patchBot}
          />
          <BotModelSetting
            botId={bot.id}
            pinned={settings.modelOverride}
            options={catalogToPickerOptions(catalog)}
            defaultRef={catalog?.catalog.defaultRef ?? null}
            onSave={saveModel}
          />
          <SettingsGroup title={t('agents.bots.sectionSchedule')} collapsible defaultOpen={false}>
            <BotCronPanel botId={bot.id} botName={bot.name} />
          </SettingsGroup>
        </>
      ) : null}
    </section>
  );
}

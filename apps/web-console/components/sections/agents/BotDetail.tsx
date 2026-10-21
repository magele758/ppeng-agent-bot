'use client';
import { BotDetailSkills } from '../../BotDetailSkills';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { detailFaceProps, isBotFaceColor, isBotFaceShape, type BotFaceColor, type BotFaceShape } from '@/lib/bot-face';
import { useI18n } from '@/lib/i18n';
import {
  createGenerationGuard,
  loadSelectedBotDetail,
  selectionForBot,
  type BotDetailLoadResult
} from '@/lib/bot-console-selection';
import { readBotSettings, type BotSettingsSnapshot } from '@/lib/bot-policy';
import type { BotPermissionMode } from '@/lib/bot-permission';
import { catalogToPickerOptions, type ModelProvidersResponse, type ModelRef } from '@/lib/model-providers';
import type { BotInfo } from '@/lib/types';
import { BOT_PERMISSIONS_SECTION_ID, readBotPermissionsTarget } from '@/lib/bot-chat-header';
import { readBotConnectionsTarget } from '@/lib/bot-recovery-link';
import { BotRuntimeControl } from '../../bot-work/BotLimits';
import { BotMemory } from '../../bot-work/BotMemory';
import { BotHistory } from '../../bot-work/BotHistory';
import { BotConnections } from '../../bot-work/BotConnections';
import { BotCronPanel } from '../../BotCronPanel';
import { BotModelSetting } from '../../BotModelSetting';
import { BotPolicySettings } from '../../BotPolicySettings';
import { BotFace } from '../../BotFace';
import { BotFaceChoice } from '../../BotFaceChoice';
import { useLab } from '../../shell/LabProvider';
import { SettingsGroup } from '../../ui';

interface BotDetailProps {
  bot: BotInfo;
  onOpenChat: (bot: BotInfo) => void;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function BotDetail({ bot, onOpenChat }: BotDetailProps) {
  const { t } = useI18n();
  const { upsertBot } = useLab();
  const [detailTab, setDetailTab] = useState('overview');
  useEffect(() => {
    const sync = () => setDetailTab(/focus=(permissions|connections)/.test(window.location.hash) ? 'permissions' : 'overview');
    sync(); window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [bot.id]);
  const [shape, setShape] = useState<BotFaceShape | null>(isBotFaceShape(bot.faceShape) ? bot.faceShape : null);
  const [color, setColor] = useState<BotFaceColor | null>(isBotFaceColor(bot.faceColor) ? bot.faceColor : null);
  const generations = useRef(createGenerationGuard());
  const [activeBotId, setActiveBotId] = useState(bot.id);
  const [sessionId, setSessionId] = useState(() => selectionForBot(bot).sessionId);
  const [settings, setSettings] = useState<BotSettingsSnapshot | null>(null);
  const [catalog, setCatalog] = useState<ModelProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (activeBotId !== bot.id) {
    setActiveBotId(bot.id);
    setSessionId(selectionForBot(bot).sessionId);
    setSettings(null);
    setError(null);
    setShape(isBotFaceShape(bot.faceShape) ? bot.faceShape : null);
    setColor(isBotFaceColor(bot.faceColor) ? bot.faceColor : null);
  }

  const botIdRef = useRef(bot.id);
  botIdRef.current = bot.id;
  const tRef = useRef(t);
  tRef.current = t;

  const applyLoadResult = useCallback(
    (generation: number, result: BotDetailLoadResult<BotSettingsSnapshot>) => {
      if (!generations.current.isCurrent(generation)) return;
      switch (result.status) {
        case 'stale':
          return;
        case 'error': {
          const reason = result.error;
          setError(
            tRef.current('agents.bots.settingsFailed', {
              error: reason instanceof Error ? reason.message : String(reason)
            })
          );
          return;
        }
        case 'ready':
          setSessionId(result.sessionId);
          setSettings(result.settings);
          setError(null);
          return;
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    },
    []
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const botId = bot.id;
      if (botIdRef.current !== botId) return;
      const generation = generations.current.begin();
      const result = await loadSelectedBotDetail({
        botId: bot.id,
        generation,
        isCurrent: (gen) => generations.current.isCurrent(gen),
        openSession: async (botId) => {
          const opened = (await api(`/api/bots/${encodeURIComponent(botId)}/open`, {
            method: 'POST',
            signal
          })) as { session: { id: string } };
          return opened.session.id;
        },
        readSettings: async (openedSessionId) => {
          const data = (await api(
            `/api/sessions/${encodeURIComponent(openedSessionId)}?includeMessages=false`,
            { signal }
          )) as { session?: { metadata?: Record<string, unknown> } };
          return readBotSettings(data.session?.metadata);
        }
      });
      if (botIdRef.current !== botId) return;
      applyLoadResult(generation, result);
    },
    [applyLoadResult, bot.id]
  );

  useEffect(() => {
    setShape(isBotFaceShape(bot.faceShape) ? bot.faceShape : null);
    setColor(isBotFaceColor(bot.faceColor) ? bot.faceColor : null);
  }, [bot.id, bot.faceColor, bot.faceShape]);

  useEffect(() => {
    setSessionId(selectionForBot(bot).sessionId);
    setSettings(null);
    setError(null);
    const ac = new AbortController();
    void load(ac.signal);
    return () => {
      generations.current.invalidate();
      ac.abort();
    };
  }, [bot.id, bot.canonicalSessionId, load]);

  useEffect(() => {
    if (!settings) return;
    if (readBotConnectionsTarget(window.location.hash)?.botId === bot.id) {
      document.getElementById('bot-connections')?.scrollIntoView({ block: 'start' });
      return;
    }
    const target = readBotPermissionsTarget(window.location.hash);
    if (!target || target.botId !== bot.id) return;
    document.getElementById(BOT_PERMISSIONS_SECTION_ID)?.scrollIntoView({ block: 'start' });
  }, [settings, bot.id]);

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
      })) as { bot?: BotInfo; warnings?: unknown };
      if (result.bot) upsertBot(result.bot);
      await load();
      return result;
    },
    [bot.id, load, upsertBot]
  );

  const saveFace = useCallback(
    async (patch: { faceShape?: BotFaceShape; faceColor?: BotFaceColor }) => {
      setError(null);
      try {
        await patchBot(patch);
      } catch (err) {
        setError(
          t('agents.bots.faceSaveFailed', { error: err instanceof Error ? err.message : String(err) })
        );
        throw err;
      }
    },
    [patchBot, t]
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
        <div className="ag-panel__identity">
          <BotFace
            name={bot.name}
            {...detailFaceProps(shape, color)}
            label={t('agents.bots.faceLabel', { name: bot.name })}
            testId="bot-detail-face"
            size="md"
          />
          <div>
            <h3 className="ag-panel__title">{bot.name}</h3>
            {bot.title && bot.title !== bot.name ? <p className="ag-panel__lead">{bot.title}</p> : null}
          </div>
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
      <div className="bot-settings-tabs" role="tablist" aria-label={t('polish.settingsTabs')}>
        {(['overview', 'permissions', 'skills', 'automation', 'history'] as const).map(tab => <button key={tab} type="button" role="tab" id={`bot-tab-${tab}`} aria-controls={`bot-page-${tab}`} aria-selected={detailTab === tab} onClick={() => setDetailTab(tab)}>{t(tab === 'skills' ? 'skillProposals.detailTab' : `polish.${tab}`)}</button>)}
      </div>
      <div role="tabpanel" id="bot-page-skills" aria-labelledby="bot-tab-skills" hidden={detailTab !== 'skills'}>{detailTab === 'skills' && <BotDetailSkills botId={bot.id}/>}</div>
      <div role="tabpanel" id="bot-page-overview" aria-labelledby="bot-tab-overview" hidden={detailTab !== 'overview'}>
      <BotFaceChoice
        name={bot.name}
        shape={shape}
        color={color}
        onShape={(next) => {
          const previous = shape;
          setShape(next);
          void saveFace({ faceShape: next }).catch(() => setShape(previous));
        }}
        onColor={(next) => {
          const previous = color;
          setColor(next);
          void saveFace({ faceColor: next }).catch(() => setColor(previous));
        }}
      />

      <BotRuntimeControl botId={bot.id}/>
      </div>
      <div role="tabpanel" id="bot-page-history" aria-labelledby="bot-tab-history" hidden={detailTab !== 'history'}>
      <BotHistory sessionId={sessionId} />
      <BotMemory botId={bot.id} sessionId={sessionId}/>
      </div>
      <div role="tabpanel" id="bot-page-permissions" aria-labelledby="bot-tab-permissions" hidden={detailTab !== 'permissions'}>
      <div id="bot-connections"><BotConnections botId={bot.id} /></div>
      {settings ? (
        <>
          <div id={BOT_PERMISSIONS_SECTION_ID} data-testid="bot-permissions">
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
          </div>
          <BotModelSetting
            botId={bot.id}
            pinned={settings.modelOverride}
            options={catalogToPickerOptions(catalog)}
            defaultRef={catalog?.catalog.defaultRef ?? null}
            onSave={saveModel}
          />
        </>
      ) : null}
      </div>
      <div role="tabpanel" id="bot-page-automation" aria-labelledby="bot-tab-automation" hidden={detailTab !== 'automation'}>
          <SettingsGroup title={t('agents.bots.sectionSchedule')}>
            <BotCronPanel botId={bot.id} botName={bot.name} />
          </SettingsGroup>
      </div>
    </section>
  );
}

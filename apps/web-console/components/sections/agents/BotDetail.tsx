'use client';
import { BotGoals } from '../../bot-work/BotGoals';
import { BotDetailSkills } from '../../BotDetailSkills';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { detailFaceProps, isBotFaceColor, isBotFaceShape, readBotFaceStyle, type BotFaceColor, type BotFaceShape, type BotFaceStyle } from '@/lib/bot-face';
import { createFaceSaveQueue, type FaceSaveKind } from '@/lib/bot-face-save';
import {
  isSoftBotColor,
  isSoftBotExpression,
  isSoftBotSilhouette,
  type SoftBotColor,
  type SoftBotExpression,
  type SoftBotSilhouette
} from '@/lib/soft-bot-face';
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
  const [style, setStyle] = useState<BotFaceStyle | null>(readBotFaceStyle(bot.faceStyle));
  const [softShape, setSoftShape] = useState<SoftBotSilhouette | null>(isSoftBotSilhouette(bot.faceShape) ? bot.faceShape : null);
  const [softColor, setSoftColor] = useState<SoftBotColor | null>(isSoftBotColor(bot.faceColor) ? bot.faceColor : null);
  const [softExpression, setSoftExpression] = useState<SoftBotExpression | null>(
    isSoftBotExpression(bot.faceExpression) ? bot.faceExpression : null
  );
  const faceNow = useRef({ shape, color, style, softShape, softColor, softExpression });
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
    setStyle(readBotFaceStyle(bot.faceStyle));
    setSoftShape(isSoftBotSilhouette(bot.faceShape) ? bot.faceShape : null);
    setSoftColor(isSoftBotColor(bot.faceColor) ? bot.faceColor : null);
    setSoftExpression(isSoftBotExpression(bot.faceExpression) ? bot.faceExpression : null);
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
    const next = {
      shape: isBotFaceShape(bot.faceShape) ? bot.faceShape : null,
      color: isBotFaceColor(bot.faceColor) ? bot.faceColor : null,
      style: readBotFaceStyle(bot.faceStyle),
      softShape: isSoftBotSilhouette(bot.faceShape) ? bot.faceShape : null,
      softColor: isSoftBotColor(bot.faceColor) ? bot.faceColor : null,
      softExpression: isSoftBotExpression(bot.faceExpression) ? bot.faceExpression : null
    };
    setShape(next.shape);
    setColor(next.color);
    setStyle(next.style);
    setSoftShape(next.softShape);
    setSoftColor(next.softColor);
    setSoftExpression(next.softExpression);
    faceNow.current = next;
  }, [bot.id, bot.faceColor, bot.faceExpression, bot.faceShape, bot.faceStyle]);

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

  const faceSave = useRef(createFaceSaveQueue(() => faceNow.current));
  const saveFace = useCallback(
    async (kind: FaceSaveKind) => {
      const turn = faceSave.current(kind, (patch) => patchBot(patch()));
      setError(null);
      try {
        await turn;
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
            botId={bot.id}
            faceStyle={style}
            {...(style === 'soft' ? {} : detailFaceProps(shape, color))}
            softSilhouette={style === 'soft' ? softShape : null}
            softColor={style === 'soft' ? softColor : null}
            softExpression={style === 'soft' ? softExpression : null}
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
        botId={bot.id}
        shape={shape}
        color={color}
        style={style}
        softSilhouette={softShape}
        softColor={softColor}
        softExpression={softExpression}
        onStyle={(next) => {
          const previous = faceNow.current.style;
          const saved: BotFaceStyle | null = next === 'classic' ? null : 'soft';
          const snap = { ...faceNow.current, style: saved };
          faceNow.current = snap;
          setStyle(saved);
          void saveFace('style').catch(() => {
            if (faceNow.current.style === saved) setStyle(previous);
          });
        }}
        onShape={(next) => {
          const previous = faceNow.current.shape;
          faceNow.current = { ...faceNow.current, shape: next };
          setShape(next);
          void saveFace('shape').catch(() => {
            if (faceNow.current.shape === next) setShape(previous);
          });
        }}
        onColor={(next) => {
          const previous = faceNow.current.color;
          faceNow.current = { ...faceNow.current, color: next };
          setColor(next);
          void saveFace('color').catch(() => {
            if (faceNow.current.color === next) setColor(previous);
          });
        }}
        onSoftSilhouette={(next) => {
          const previous = faceNow.current.softShape;
          faceNow.current = { ...faceNow.current, softShape: next, style: 'soft' };
          setSoftShape(next);
          setStyle('soft');
          void saveFace('soft-shape').catch(() => {
            if (faceNow.current.softShape === next) setSoftShape(previous);
          });
        }}
        onSoftColor={(next) => {
          const previous = faceNow.current.softColor;
          faceNow.current = { ...faceNow.current, softColor: next, style: 'soft' };
          setSoftColor(next);
          setStyle('soft');
          void saveFace('soft-color').catch(() => {
            if (faceNow.current.softColor === next) setSoftColor(previous);
          });
        }}
        onSoftExpression={(next) => {
          const previous = faceNow.current.softExpression;
          faceNow.current = { ...faceNow.current, softExpression: next, style: 'soft' };
          setSoftExpression(next);
          setStyle('soft');
          void saveFace('soft-expression').catch(() => {
            if (faceNow.current.softExpression === next) setSoftExpression(previous);
          });
        }}
      />

      {sessionId && <BotGoals key={`${bot.id}:${sessionId}`} botId={bot.id} sessionId={sessionId}/>}
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

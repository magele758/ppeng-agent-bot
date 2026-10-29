'use client';
import { BotBasics } from '../../BotBasics';
import { BotGoals } from '../../bot-work/BotGoals';
import { BotDetailSkills } from '../../BotDetailSkills';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  onOpenChat?: (bot: BotInfo) => void;
  records?: ReactNode;
  embedded?: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function savedFace(bot: BotInfo) {
  return {
    shape: isBotFaceShape(bot.faceShape) ? bot.faceShape : null,
    color: isBotFaceColor(bot.faceColor) ? bot.faceColor : null,
    style: readBotFaceStyle(bot.faceStyle),
    ...savedSoftFace(bot)
  };
}

function savedSoftFace(bot: BotInfo) {
  return {
    softShape: isSoftBotSilhouette(bot.faceShape) ? bot.faceShape : null,
    softColor: isSoftBotColor(bot.faceColor) ? bot.faceColor : null,
    softExpression: isSoftBotExpression(bot.faceExpression) ? bot.faceExpression : null
  };
}

export function BotDetail({ bot, onOpenChat, records, embedded = false }: BotDetailProps) {
  const { t } = useI18n();
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const face = savedFace(bot);
  const { upsertBot } = useLab();
  const [detailTab, setDetailTab] = useState('overview');
  const [visitedCapabilities, setVisitedCapabilities] = useState(false);
  const [saveEffect, setSaveEffect] = useState<'nextStep'|'nextRun'|'immediate'|null>(null);
  useEffect(()=>{if(detailTab==='permissions')setVisitedCapabilities(true);},[detailTab]);
  useEffect(() => {
    const sync = () => setDetailTab(/focus=connections/.test(window.location.hash) ? 'permissions' : 'overview');
    sync(); window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [bot.id]);
  const [shape, setShape] = useState<BotFaceShape | null>(face.shape);
  const [color, setColor] = useState<BotFaceColor | null>(face.color);
  const [style, setStyle] = useState<BotFaceStyle | null>(face.style);
  const [softShape, setSoftShape] = useState<SoftBotSilhouette | null>(face.softShape);
  const [softColor, setSoftColor] = useState<SoftBotColor | null>(face.softColor);
  const [softExpression, setSoftExpression] = useState<SoftBotExpression | null>(face.softExpression);
  const faceNow = useRef({ shape, color, style, softShape, softColor, softExpression });
  const generations = useRef(createGenerationGuard());
  const [activeBotId, setActiveBotId] = useState(bot.id);
  const [sessionId, setSessionId] = useState(() => selectionForBot(bot).sessionId);
  const [settings, setSettings] = useState<BotSettingsSnapshot | null>(null);
  const [catalog, setCatalog] = useState<ModelProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (activeBotId !== bot.id) {
    setActiveBotId(bot.id);
    setSaveEffect(null);
    setSessionId(selectionForBot(bot).sessionId);
    setSettings(null);
    setError(null);
    setShape(face.shape);
    setColor(face.color);
    setStyle(face.style);
    setSoftShape(face.softShape);
    setSoftColor(face.softColor);
    setSoftExpression(face.softExpression);
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
    const next = savedFace(bot);
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
      panelRef.current?.querySelector('[data-bot-connections]')?.scrollIntoView({ block: 'start' });
      return;
    }
    const target = readBotPermissionsTarget(window.location.hash);
    if (!target || target.botId !== bot.id) return;
    panelRef.current?.querySelector('[data-testid=bot-permissions]')?.scrollIntoView({ block: 'start' });
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
      setSaveEffect(null);
      const result = (await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch)
      })) as { bot?: BotInfo; warnings?: unknown };
      if (result.bot) upsertBot(result.bot);
      await load();
      setSaveEffect(['maxTurns','name','title','description'].some(key=>key in patch) ? 'nextRun' : 'nextStep');
      return result;
    },
    [bot.id, load, upsertBot]
  );

  const faceSave = useRef(createFaceSaveQueue(() => faceNow.current));
  const saveFace = useCallback(
    async (kind: FaceSaveKind) => {
      setSaveEffect(null);
      const botId = bot.id;
      const turn = faceSave.current(kind, async (patch) => {
        if (botIdRef.current !== botId) return;
        const body = patch();
        const result = (await api(`/api/bots/${encodeURIComponent(botId)}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify(body)
        })) as { bot?: BotInfo; warnings?: unknown };
        if (botIdRef.current !== botId) return;
        if (result.bot) upsertBot(result.bot);
        await load();
        return result;
      });
      setError(null);
      try {
        await turn;
        setSaveEffect('immediate');
      } catch (err) {
        setError(
          t('agents.bots.faceSaveFailed', { error: err instanceof Error ? err.message : String(err) })
        );
        throw err;
      }
    },
    [bot.id, load, upsertBot, t]
  );


  const savePermission = useCallback(
    async (mode: BotPermissionMode, opts?: { confirmBypass?: boolean }) => {
      setSaveEffect(null);
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          permissionMode: mode,
          ...(mode === 'bypass' && opts?.confirmBypass ? { confirmBypass: true } : {})
        })
      });
      await load();
      setSaveEffect('nextStep');
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
    <section ref={panelRef} className="ag-panel" aria-label={t('agents.bots.detailTitle')} id={embedded ? 'botDetailEmbedded' : 'botDetail'} data-testid={embedded ? "bot-detail-embedded" : "bot-detail"}>
      <div className="ag-panel__head">
        <div className="ag-panel__identity">
          <BotFace
            name={bot.name}
            botId={bot.id}
            faceStyle={style}
            {...((style === 'soft' || style === 'bloub') ? {} : detailFaceProps(shape, color))}
            softSilhouette={(style === 'soft' || style === 'bloub') ? softShape : null}
            softColor={(style === 'soft' || style === 'bloub') ? softColor : null}
            softExpression={(style === 'soft' || style === 'bloub') ? softExpression : null}
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
          {onOpenChat && <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenChat(bot)}>
            {t('agents.bots.openChat')}
          </button>}
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
        {(['overview', 'permissions', 'automation', 'history'] as const).map(tab => <button key={tab} type="button" role="tab" id={`${panelId}-tab-${tab}`} aria-controls={`${panelId}-page-${tab}`} aria-selected={detailTab === tab} onClick={() => setDetailTab(tab)}>{t(tab === 'overview' ? 'botSettings.basic' : tab === 'permissions' ? 'botSettings.capabilities' : tab === 'automation' ? 'botSettings.automation' : 'botSettings.records')}</button>)}
      </div>
      <p>{t('botSettings.scope')}</p>
      {saveEffect && <p role="status" data-testid="bot-save-effect">{t(`botSettings.${saveEffect}`)}</p>}
      <div role="tabpanel" id={`${panelId}-page-overview`} aria-labelledby={`${panelId}-tab-overview`} hidden={detailTab !== 'overview'}>
      <BotBasics key={bot.id} bot={bot} onSave={patchBot} />
      {settings && <>          <BotModelSetting
            botId={bot.id}
            pinned={settings.modelOverride}
            options={catalogToPickerOptions(catalog)}
            defaultRef={catalog?.catalog.defaultRef ?? null}
            onSave={saveModel}
          />          <div id={embedded ? `${panelId}-permissions` : BOT_PERMISSIONS_SECTION_ID} data-testid="bot-permissions">
            <BotPolicySettings
              botId={bot.id}
              maxTurns={settings.maxTurns}
              permissionMode={settings.permissionMode}
              onSavePermission={savePermission}
              allowedTools={settings.allowedTools}
              onSave={patchBot}
            />
          </div></>}
      <details><summary>{t('botSettings.appearance')}</summary>
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
          const saved: BotFaceStyle | null = next === 'classic' ? null : next;
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
          faceNow.current = { ...faceNow.current, softShape: next, style: faceNow.current.style === 'bloub' ? 'bloub' : 'soft' };
          setSoftShape(next);
          setStyle(faceNow.current.style === 'bloub' ? 'bloub' : 'soft');
          void saveFace('soft-shape').catch(() => {
            if (faceNow.current.softShape === next) setSoftShape(previous);
          });
        }}
        onSoftColor={(next) => {
          const previous = faceNow.current.softColor;
          faceNow.current = { ...faceNow.current, softColor: next, style: faceNow.current.style === 'bloub' ? 'bloub' : 'soft' };
          setSoftColor(next);
          setStyle(faceNow.current.style === 'bloub' ? 'bloub' : 'soft');
          void saveFace('soft-color').catch(() => {
            if (faceNow.current.softColor === next) setSoftColor(previous);
          });
        }}
        onSoftExpression={(next) => {
          const previous = faceNow.current.softExpression;
          faceNow.current = { ...faceNow.current, softExpression: next, style: faceNow.current.style === 'bloub' ? 'bloub' : 'soft' };
          setSoftExpression(next);
          setStyle(faceNow.current.style === 'bloub' ? 'bloub' : 'soft');
          void saveFace('soft-expression').catch(() => {
            if (faceNow.current.softExpression === next) setSoftExpression(previous);
          });
        }}
      />

      </details>
      {sessionId && <BotGoals key={`${bot.id}:${sessionId}`} botId={bot.id} sessionId={sessionId}/>}
      <BotRuntimeControl botId={bot.id}/>
      </div>
      <div role="tabpanel" id={`${panelId}-page-history`} aria-labelledby={`${panelId}-tab-history`} hidden={detailTab !== 'history'}>
      <BotHistory sessionId={sessionId} />
      <BotMemory botId={bot.id} sessionId={sessionId}/>
      {records}
      </div>
      <div role="tabpanel" id={`${panelId}-page-permissions`} aria-labelledby={`${panelId}-tab-permissions`} hidden={detailTab !== 'permissions'}>
      {settings && <BotPolicySettings onlyTools botId={bot.id} maxTurns={settings.maxTurns} permissionMode={settings.permissionMode} onSavePermission={savePermission} allowedTools={settings.allowedTools} onSave={patchBot} />}
      {visitedCapabilities && <BotDetailSkills botId={bot.id}/>}
      <div data-bot-connections id={embedded ? `${panelId}-connections` : "bot-connections"}><BotConnections botId={bot.id} /></div>
      </div>
      <div role="tabpanel" id={`${panelId}-page-automation`} aria-labelledby={`${panelId}-tab-automation`} hidden={detailTab !== 'automation'}>
          <SettingsGroup title={t('agents.bots.sectionSchedule')}>
            <BotCronPanel botId={bot.id} botName={bot.name} />
          </SettingsGroup>
      </div>
    </section>
  );
}

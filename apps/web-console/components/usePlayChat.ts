'use client';

import { botComposerStatusText, planBotComposerSend } from '@/lib/bot-chat-commands';
import { parseBotModelOverride, resolveLoadedComposerModelRef } from '@/lib/bot-model';
import { api } from '@/lib/api';
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from '@/lib/speech-dictation';
import { renderMarkdown } from '@/lib/markdown';
import { rollbackToCheckpoint, streamCheckpoint, type StreamSegment } from '@/lib/stream-segments';
import { feedSseBuffer } from '@/lib/sse';
import { userPreviewText } from '@/lib/chat-utils';
import { playSendAckToneIfEnabled } from '@/lib/send-ack-feedback';
import {
  parseSessionChrome,
  type AutonomyLevel,
  type SessionChromeMeta,
  autonomyToPermission,
  permissionToAutonomy
} from '@/lib/session-chrome';
import {
  catalogNeedsSetup,
  catalogToPickerOptions,
  decodeModelValue,
  encodeModelValue,
  resolvePickerModelRef,
  type ModelPickerOption,
  type ModelRef,
  type ModelProvidersResponse
} from '@/lib/model-providers';
import type { AgentInfo, BotInfo, ChatMessage } from '@/lib/types';
import {
  defaultWorkspaceBinding,
  emptyWorkspaceAvailability,
  parseWorkspaceBinding,
  parseWorkspaceBindingBound,
  workspaceBindingBody,
  type WorkspaceAvailability,
  type WorkspaceBinding
} from '@/lib/workspace-binding';
import {
  parseOpenBotResponse,
  type OpenBotResponse,
  type PlaySurface
} from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import {
  mapSteerInboxItems,
  steerBodyFromQueryMode,
  type QueryExecMode,
  type SteerInboxItem,
  type SteerInterruptPolicy
} from '@/lib/query-queue';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Stream already persisted the user turn; do not put the draft back in the composer. */
class PlayStreamError extends Error {
  readonly persisted: boolean;
  constructor(message: string, persisted = true) {
    super(message);
    this.name = 'PlayStreamError';
    this.persisted = persisted;
  }
}

export type CompactPolicy = 'keep_recent' | 'after_any_assistant' | 'after_text_assistant';
export type OrchestrationEngine = 'legacy' | 'ptc';
export type LabTaskMode =
  | 'computer'
  | 'browser'
  | 'auto'
  | 'deep_research'
  | 'planner'
  | 'teams'
  | 'fast'
  | 'dynamic_workflow';
export type LabSkillScope = 'full' | 'requested';

const TASK_MODES = new Set<LabTaskMode>([
  'computer',
  'browser',
  'auto',
  'deep_research',
  'planner',
  'teams',
  'fast',
  'dynamic_workflow'
]);

function parseLabTaskMode(raw: unknown): LabTaskMode | undefined {
  if (raw === 'standard') return 'auto';
  return typeof raw === 'string' && TASK_MODES.has(raw as LabTaskMode)
    ? (raw as LabTaskMode)
    : undefined;
}

export type SessionModelViewPayload = {
  stored: ChatMessage[];
  modelView: ChatMessage[];
  stats: { collapsed: number; trimmed: number; charsSaved: number };
  policy: CompactPolicy;
};

export type OptionalToolCatalogGroup = {
  id: string;
  title: string;
  description?: string;
  items: Array<{ id: string; title: string; description?: string; tool_names: string[] }>;
};

function optionalGroupsBody(feature: boolean, ids: string[]): { enabledOptionalToolGroups?: string[] } {
  if (!feature) return {};
  return { enabledOptionalToolGroups: ids };
}

function modelRefBody(ref: ModelRef | null): { modelRef?: ModelRef } {
  if (!ref) return {};
  return { modelRef: ref };
}

function orchestrationBody(
  taskMode: LabTaskMode,
  engine: OrchestrationEngine,
  skillScope: LabSkillScope
): {
  taskRunMode: LabTaskMode;
  orchestrationEngine: OrchestrationEngine;
  skillScope: LabSkillScope;
} {
  const dw = taskMode === 'dynamic_workflow';
  return {
    taskRunMode: taskMode,
    orchestrationEngine: dw ? (engine === 'legacy' ? 'legacy' : 'ptc') : 'legacy',
    skillScope
  };
}

const SCROLL_BOTTOM_EPS = 16;

function canScrollFeed(el: HTMLElement) {
  return el.scrollHeight > el.clientHeight + 1;
}

function isNearBottom(el: HTMLElement | null) {
  if (!el) return true;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (!canScrollFeed(el)) return true;
  return scrollHeight - scrollTop - clientHeight <= SCROLL_BOTTOM_EPS;
}

function scrollElToBottom(el: HTMLElement) {
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
}

function fileToBase64Data(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface PlayChatDeps {
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  selectedSessionRef: React.MutableRefObject<string | null>;
  sessionListStickTopRef: React.MutableRefObject<boolean>;
  agents: AgentInfo[];
  bots: BotInfo[];
  upsertBot?: (bot: BotInfo) => void;
  playSurface: PlaySurface;
  onPlaySurfaceChange?: (surface: PlaySurface) => void;
  tick: (opts?: { includePlayPanel?: boolean }) => Promise<void>;
}

export function usePlayChat(deps: PlayChatDeps) {
  const {
    selectedSessionId,
    setSelectedSessionId,
    selectedSessionRef,
    sessionListStickTopRef,
    agents,
    upsertBot,
    playSurface,
    onPlaySurfaceChange,
    tick,
  } = deps;
  const { t } = useI18n();

  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [playTitle, setPlayTitle] = useState(t('play.empty.selectOrCreateSession'));
  const [playMeta, setPlayMeta] = useState('');
  const [sessionChrome, setSessionChrome] = useState<SessionChromeMeta | null>(null);
  const [goalDraft, setGoalDraft] = useState('');
  const [autonomyDraft, setAutonomyDraft] = useState<AutonomyLevel>('balanced');
  const [playInput, setPlayInput] = useState('');
  const [imageUrlInput, setImageUrlInput] = useState('');
  const [pendingImageAssetIds, setPendingImageAssetIds] = useState<string[]>([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
  const [sessionFileArtifacts, setSessionFileArtifacts] = useState<
    Array<{ id: string; title?: string; handle?: string }>
  >([]);
  const [playStatus, setPlayStatus] = useState<{ text: string; ok?: boolean; err?: boolean }>({ text: '' });
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  const [streamOverlay, setStreamOverlay] = useState<{ segments: StreamSegment[] } | null>(null);
  const [waitTyping, setWaitTyping] = useState(false);
  const [playSending, setPlaySending] = useState(false);
  const [composerAckFlash, setComposerAckFlash] = useState(false);
  const [mode, setMode] = useState<'chat' | 'task'>('chat');
  const [orchestrationEngine, setOrchestrationEngine] = useState<OrchestrationEngine>('legacy');
  const [taskMode, setTaskMode] = useState<LabTaskMode>('auto');
  const [skillScope, setSkillScope] = useState<LabSkillScope>('full');
  const [taskModeBound, setTaskModeBound] = useState(false);
  const [workspaceBinding, setWorkspaceBinding] = useState<WorkspaceBinding>(defaultWorkspaceBinding);
  const [workspaceBindingBound, setWorkspaceBindingBound] = useState(false);
  const [workspaceAvailability, setWorkspaceAvailability] = useState<WorkspaceAvailability>(
    emptyWorkspaceAvailability
  );
  const [agentId, setAgentId] = useState('');
  const [botId, setBotId] = useState('');
  const botIdRef = useRef('');
  const [botModelOverride, setBotModelOverride] = useState<ModelRef | null>(null);
  const loadedPinRef = useRef<{ sid: string; pinned: boolean }>({ sid: '', pinned: false });
  const [modelOptions, setModelOptions] = useState<ModelPickerOption[]>([]);
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const modelRefForSend = botModelOverride ? null : modelRef;
  const [modelCatalog, setModelCatalog] = useState<ModelProvidersResponse | null>(null);
  const modelCatalogRef = useRef(modelCatalog);
  modelCatalogRef.current = modelCatalog;
  const [useStream, setUseStream] = useState(true);
  const [optionalToolGroupsFeature, setOptionalToolGroupsFeature] = useState(false);
  const [optionalToolCatalog, setOptionalToolCatalog] = useState<OptionalToolCatalogGroup[]>([]);
  const [enabledOptionalGroupIds, setEnabledOptionalGroupIds] = useState<string[]>([]);
  const [speechDictationAvailable, setSpeechDictationAvailable] = useState(false);
  const [speechDictating, setSpeechDictating] = useState(false);
  const [showModelView, setShowModelView] = useState(false);
  const [modelViewPayload, setModelViewPayload] = useState<SessionModelViewPayload | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [steerInterruptPolicy, setSteerInterruptPolicyState] = useState<SteerInterruptPolicy>('queue');
  const [steerInbox, setSteerInbox] = useState<SteerInboxItem[]>([]);
  const [steerPolicyBusy, setSteerPolicyBusy] = useState(false);
  const [queryExecMode, setQueryExecMode] = useState<QueryExecMode>('steering');

  const playMessagesRef = useRef<HTMLDivElement>(null);
  const playInputRef = useRef<HTMLTextAreaElement>(null);
  const playInputLiveRef = useRef('');
  const speechRecRef = useRef<SpeechRecognitionLike | null>(null);
  const speechPrefixRef = useRef('');
  const speechFinalAccumRef = useRef('');
  const playStickToBottomRef = useRef(true);
  const lastPlayScrollTopRef = useRef(0);
  const stickRafRef = useRef<number | null>(null);
  const composerAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const acknowledgeLocalSendCommitted = useCallback(() => {
    playSendAckToneIfEnabled();
    if (composerAckTimerRef.current != null) {
      clearTimeout(composerAckTimerRef.current);
    }
    setComposerAckFlash(true);
    composerAckTimerRef.current = setTimeout(() => {
      setComposerAckFlash(false);
      composerAckTimerRef.current = null;
    }, 240);
  }, []);

  const clearComposerOnly = () => {
    setPlayInput('');
    setPendingImageAssetIds([]);
    setPendingAttachmentIds([]);
  };

  const clearStreamingShell = () => {
    setOptimisticUser(null);
    setStreamOverlay(null);
    setWaitTyping(false);
  };

  const cancelScheduledPlayScroll = useCallback(() => {
    if (stickRafRef.current == null) return;
    cancelAnimationFrame(stickRafRef.current);
    stickRafRef.current = null;
  }, []);

  const scrollPlayToBottom = useCallback(() => {
    const el = playMessagesRef.current;
    if (!el) return;
    scrollElToBottom(el);
    lastPlayScrollTopRef.current = el.scrollTop;
  }, []);

  const scheduleScrollPlayToBottom = useCallback(() => {
    cancelScheduledPlayScroll();
    stickRafRef.current = requestAnimationFrame(() => {
      stickRafRef.current = null;
      if (!playStickToBottomRef.current) return;
      scrollPlayToBottom();
    });
  }, [cancelScheduledPlayScroll, scrollPlayToBottom]);

  const requestScrollPlayToBottom = useCallback(() => {
    playStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollPlayToBottom();
    scheduleScrollPlayToBottom();
  }, [scheduleScrollPlayToBottom, scrollPlayToBottom]);

  const handlePlayMessagesScroll = useCallback(() => {
    const el = playMessagesRef.current;
    if (!el) return;

    const currentTop = el.scrollTop;
    const userMovedUp = currentTop < lastPlayScrollTopRef.current - 1;
    lastPlayScrollTopRef.current = currentTop;

    if (!canScrollFeed(el) || isNearBottom(el)) {
      playStickToBottomRef.current = true;
      setShowJumpToLatest(false);
      return;
    }

    if (userMovedUp) {
      playStickToBottomRef.current = false;
      cancelScheduledPlayScroll();
      setShowJumpToLatest(true);
      return;
    }

    setShowJumpToLatest(!playStickToBottomRef.current);
  }, [cancelScheduledPlayScroll]);

  useEffect(
    () => () => {
      cancelScheduledPlayScroll();
    },
    [cancelScheduledPlayScroll]
  );

  useEffect(() => {
    playStickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [selectedSessionId]);

  useEffect(() => {
    const el = playMessagesRef.current;
    if (!el) return;
    const track = el.querySelector('.chat-feed__track') ?? el.firstElementChild;
    if (!track) return;
    const ro = new ResizeObserver(() => {
      if (!playStickToBottomRef.current) return;
      scrollPlayToBottom();
    });
    ro.observe(track);
    return () => ro.disconnect();
  }, [scrollPlayToBottom, selectedSessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await api('/api/optional-tool-groups')) as {
          enabled?: boolean;
          catalog?: { groups?: OptionalToolCatalogGroup[] };
        };
        if (cancelled) return;
        setOptionalToolGroupsFeature(data.enabled === true);
        setOptionalToolCatalog(data.catalog?.groups ?? []);
      } catch {
        if (!cancelled) {
          setOptionalToolGroupsFeature(false);
          setOptionalToolCatalog([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await api('/api/loop/settings')) as {
          settings?: { steerInterruptPolicy?: string };
        };
        const next = data.settings?.steerInterruptPolicy;
        if (!cancelled && (next === 'queue' || next === 'steer' || next === 'disabled')) {
          setSteerInterruptPolicyState(next);
        }
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const queryExecModeRef = useRef(queryExecMode);
  queryExecModeRef.current = queryExecMode;

  const updateSteerItem = useCallback(
    async (itemId: string, text: string) => {
      const sid = selectedSessionRef.current;
      if (!sid) return;
      const next = text.trim();
      if (!next) return;
      const data = (await api(`/api/sessions/${sid}/steer/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: next })
      })) as { item?: SteerInboxItem; inbox?: SteerInboxItem[] };
      if (Array.isArray(data.inbox)) {
        setSteerInbox(mapSteerInboxItems(data.inbox));
      } else if (data.item?.id) {
        setSteerInbox((prev) =>
          prev.map((item) => (item.id === itemId ? { ...item, text: data.item!.text || next } : item))
        );
      }
      setPlayStatus({ text: t('play.status.queueUpdated'), ok: true });
    },
    [selectedSessionRef, t]
  );

  const dropSteerItem = useCallback(
    async (itemId: string) => {
      const sid = selectedSessionRef.current;
      if (!sid) return;
      const data = (await api(`/api/sessions/${sid}/steer/${itemId}`, {
        method: 'DELETE'
      })) as { inbox?: SteerInboxItem[] };
      setSteerInbox((prev) => prev.filter((item) => item.id !== itemId));
      if (Array.isArray(data.inbox)) {
        setSteerInbox(mapSteerInboxItems(data.inbox));
      }
      setPlayStatus({ text: t('play.status.queueDropped'), ok: true });
    },
    [selectedSessionRef, t]
  );

  const setSteerItemMode = useCallback(
    async (itemId: string, mode: QueryExecMode) => {
      const sid = selectedSessionRef.current;
      if (!sid) return;
      if (mode === 'steering') {
        setSteerInbox((prev) => prev.map((item) => (item.id === itemId ? { ...item, mode } : item)));
        return;
      }
      const data = (await api(`/api/sessions/${sid}/steer/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'subagent' })
      })) as { spawned?: boolean; inbox?: SteerInboxItem[] };
      setSteerInbox((prev) => prev.filter((item) => item.id !== itemId));
      if (Array.isArray(data.inbox)) {
        setSteerInbox(mapSteerInboxItems(data.inbox));
      }
      setPlayStatus({
        text: data.spawned ? t('play.status.queuedSubagent') : t('play.status.queueDropped'),
        ok: true
      });
    },
    [selectedSessionRef, t]
  );

  const saveSteerInterruptPolicy = useCallback(async (next: SteerInterruptPolicy) => {
    setSteerPolicyBusy(true);
    try {
      const data = (await api('/api/loop/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steerInterruptPolicy: next })
      })) as { settings?: { steerInterruptPolicy?: string } };
      const saved = data.settings?.steerInterruptPolicy;
      setSteerInterruptPolicyState(
        saved === 'queue' || saved === 'steer' || saved === 'disabled' ? saved : next
      );
    } catch (err) {
      setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
    } finally {
      setSteerPolicyBusy(false);
    }
  }, []);

  const applyModelCatalog = useCallback((data: ModelProvidersResponse) => {
    setModelCatalog(data);
    const pickerOptions = catalogToPickerOptions(data);
    setModelOptions(pickerOptions);
    setModelRef((cur) => resolvePickerModelRef(pickerOptions, cur, data.catalog?.defaultRef ?? null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await api('/api/model-providers')) as ModelProvidersResponse;
        if (cancelled) return;
        applyModelCatalog(data);
      } catch {
        if (!cancelled) setModelOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyModelCatalog]);

  useEffect(() => {
    playInputLiveRef.current = playInput;
  }, [playInput]);

  useEffect(() => {
    botIdRef.current = botId;
  }, [botId]);

  useEffect(() => {
    setSpeechDictationAvailable(getSpeechRecognitionCtor() !== null);
  }, []);

  useEffect(() => {
    return () => {
      if (composerAckTimerRef.current != null) {
        clearTimeout(composerAckTimerRef.current);
        composerAckTimerRef.current = null;
      }
      const r = speechRecRef.current;
      speechRecRef.current = null;
      if (!r) return;
      try {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.abort();
      } catch {
        try {
          r.stop();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const stopSpeechDictation = useCallback(() => {
    const r = speechRecRef.current;
    speechRecRef.current = null;
    if (!r) {
      setSpeechDictating(false);
      return;
    }
    try {
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      r.abort();
    } catch {
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    setSpeechDictating(false);
  }, []);

  const toggleSpeechDictation = useCallback(() => {
    if (speechRecRef.current) {
      stopSpeechDictation();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setPlayStatus({ text: t('play.status.speechUnsupported'), err: true });
      return;
    }
    speechPrefixRef.current = playInputLiveRef.current;
    speechFinalAccumRef.current = '';
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang =
      typeof navigator !== 'undefined' && navigator.language && navigator.language.length > 0
        ? navigator.language
        : 'zh-CN';
    rec.onresult = (ev) => {
      let interim = '';
      let deltaFinal = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const res = ev.results[i];
        if (!res?.[0]) continue;
        const t = res[0].transcript;
        if (res.isFinal) deltaFinal += t;
        else interim += t;
      }
      speechFinalAccumRef.current += deltaFinal;
      setPlayInput(speechPrefixRef.current + speechFinalAccumRef.current + interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'aborted' || ev.error === 'no-speech') return;
      setPlayStatus({ text: t('play.status.speechError', { error: ev.error }), err: true });
      stopSpeechDictation();
    };
    rec.onend = () => {
      if (speechRecRef.current !== rec) return;
      speechRecRef.current = null;
      setSpeechDictating(false);
    };
    try {
      rec.start();
      speechRecRef.current = rec;
      setSpeechDictating(true);
      setPlayStatus({ text: t('play.status.speechListening'), ok: true });
    } catch (e) {
      setPlayStatus({ text: e instanceof Error ? e.message : t('play.status.speechStartFailed'), err: true });
    }
  }, [stopSpeechDictation, t]);

  const toggleOptionalGroup = useCallback(
    async (groupId: string, on: boolean) => {
      const next = on
        ? [...new Set([...enabledOptionalGroupIds, groupId])]
        : enabledOptionalGroupIds.filter((id) => id !== groupId);
      setEnabledOptionalGroupIds(next);
      const sid = selectedSessionRef.current;
      if (sid && optionalToolGroupsFeature) {
        try {
          await api(`/api/sessions/${encodeURIComponent(sid)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabledOptionalToolGroups: next }),
          });
          await tick();
        } catch {
          setEnabledOptionalGroupIds(enabledOptionalGroupIds);
        }
      }
    },
    [enabledOptionalGroupIds, optionalToolGroupsFeature, selectedSessionRef, tick]
  );

  const saveModelRef = useCallback(
    async (next: ModelRef) => {
      setModelRef(next);
      const sid = selectedSessionRef.current;
      try {
        if (sid) {
          await api(`/api/sessions/${encodeURIComponent(sid)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelRef: next })
          });
        }
        await api('/api/model-providers/default', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultRef: next })
        });
      } catch (e) {
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
      }
    },
    [selectedSessionRef]
  );

  const refreshPlayPanel = useCallback(async () => {
    const sid = selectedSessionRef.current;
    if (!sid) {
      setPlayTitle(t('play.empty.selectOrCreateSession'));
      setPlayMeta('');
      setSessionChrome(null);
      setSessionMessages([]);
      setOrchestrationEngine('legacy');
      setEnabledOptionalGroupIds([]);
      setModelViewPayload(null);
      setSessionFileArtifacts([]);
      setSteerInbox([]);
      setWorkspaceBinding(defaultWorkspaceBinding());
      setWorkspaceBindingBound(false);
      setWorkspaceAvailability(emptyWorkspaceAvailability());
      setBotModelOverride(null);
      loadedPinRef.current = { sid: '', pinned: false };
      return;
    }
    try {
      const data = (await api(`/api/sessions/${sid}`)) as {
        session: {
          title: string;
          mode: string;
          status: string;
          agentId: string;
          createdAt?: string;
          updatedAt?: string;
          metadata?: Record<string, unknown>;
        };
        messages: ChatMessage[];
        inbox?: SteerInboxItem[];
      };
      const chrome = parseSessionChrome(data.session.metadata, data.session.status, {
        createdAt: data.session.createdAt,
        updatedAt: data.session.updatedAt
      });
      setPlayTitle(data.session.title || sid.slice(0, 12));
      setPlayMeta(`${data.session.mode} · ${data.session.status} · agent=${data.session.agentId}`);
      if (playSurface !== 'bot' && data.session.agentId) {
        setAgentId(data.session.agentId);
      }
      if (data.session.mode === 'task' || data.session.mode === 'chat') {
        setMode(data.session.mode);
      }
      const savedEngine =
        data.session.metadata?.orchestrationEngine ?? data.session.metadata?.orchestration_engine;
      const savedRunMode = parseLabTaskMode(
        data.session.metadata?.taskRunMode ?? data.session.metadata?.task_run_mode
      );
      const nextMode = savedRunMode ?? 'auto';
      setTaskMode(nextMode);
      setTaskModeBound(data.session.metadata?.taskRunModeBound === true);
      setWorkspaceBinding(parseWorkspaceBinding(data.session.metadata));
      setWorkspaceBindingBound(parseWorkspaceBindingBound(data.session.metadata));
      const savedScope = data.session.metadata?.skillScope ?? data.session.metadata?.skill_scope;
      setSkillScope(savedScope === 'requested' ? 'requested' : 'full');
      setOrchestrationEngine(
        savedEngine === 'ptc' ||
          (savedEngine !== 'legacy' && nextMode === 'dynamic_workflow')
          ? 'ptc'
          : 'legacy'
      );
      setSessionChrome(chrome);
      setGoalDraft(chrome.goalCondition ?? '');
      setAutonomyDraft(permissionToAutonomy(chrome.permissionMode));
      setBotModelOverride(parseBotModelOverride(data.session.metadata));
      setSessionMessages(data.messages ?? []);
      setSteerInbox(mapSteerInboxItems(data.inbox));
      const eg = data.session.metadata?.enabledOptionalToolGroups;
      setEnabledOptionalGroupIds(Array.isArray(eg) ? eg.map(String) : []);
      const nextPin = parseBotModelOverride(data.session.metadata);
      const catalog = modelCatalogRef.current;
      const prevLoad = loadedPinRef.current;
      setModelRef((cur) =>
        resolveLoadedComposerModelRef({
          metadata: data.session.metadata,
          options: catalogToPickerOptions(catalog),
          catalogDefault: catalog?.catalog.defaultRef ?? null,
          current: cur,
          sameSession: prevLoad.sid === sid,
          pinLifted: prevLoad.sid === sid && prevLoad.pinned && !nextPin
        })
      );
      loadedPinRef.current = { sid, pinned: nextPin !== null };
      try {
        const view = (await api(`/api/sessions/${sid}/model-view`)) as SessionModelViewPayload;
        setModelViewPayload(view);
      } catch {
        setModelViewPayload(null);
      }
      try {
        const arts = (await api(`/api/sessions/${sid}/artifacts`)) as {
          artifacts?: Array<{ id: string; title?: string; fileName?: string }>;
        };
        setSessionFileArtifacts(
          (arts.artifacts ?? []).map((a) => ({
            id: a.id,
            title: a.title || a.fileName,
            handle: a.id
          }))
        );
      } catch {
        setSessionFileArtifacts([]);
      }
    } catch {
      setPlayTitle(t('play.status.loadFailed'));
      setPlayMeta('');
      setSessionChrome(null);
      setSessionMessages([]);
      setOrchestrationEngine('legacy');
      setTaskMode('auto');
      setSkillScope('full');
      setTaskModeBound(false);
      setWorkspaceBinding(defaultWorkspaceBinding());
      setWorkspaceBindingBound(false);
      setWorkspaceAvailability(emptyWorkspaceAvailability());
      setEnabledOptionalGroupIds([]);
      setModelViewPayload(null);
      setSessionFileArtifacts([]);
      setSteerInbox([]);
    }
  }, [playSurface, selectedSessionRef, t]);

  useEffect(() => {
    const live = playSending || Boolean(streamOverlay) || waitTyping;
    if (!live) return;
    const sid = selectedSessionRef.current;
    if (!sid) return;
    let cancelled = false;
    const pullChrome = async () => {
      try {
        const data = (await api(`/api/sessions/${sid}`)) as {
          session: {
            status: string;
            createdAt?: string;
            updatedAt?: string;
            metadata?: Record<string, unknown>;
          };
          inbox?: SteerInboxItem[];
        };
        if (cancelled) return;
        setSessionChrome(
          parseSessionChrome(data.session.metadata, data.session.status, {
            createdAt: data.session.createdAt,
            updatedAt: data.session.updatedAt
          })
        );
        setSteerInbox(mapSteerInboxItems(data.inbox));
      } catch {
        /* live chrome pull is best-effort */
      }
    };
    void pullChrome();
    const timer = setInterval(() => void pullChrome(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [playSending, streamOverlay, waitTyping, selectedSessionId, selectedSessionRef]);

  const saveGoalCondition = useCallback(
    async (condition: string) => {
      const sid = selectedSessionRef.current;
      if (!sid) return;
      const cond = condition.trim();
      await api(`/api/sessions/${sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          cond
            ? { goalCondition: cond, goalEnabled: true }
            : { goalCondition: '', goalEnabled: false }
        )
      });
      await refreshPlayPanel();
    },
    [selectedSessionRef, refreshPlayPanel]
  );

  const persistPendingStrategy = useCallback(
    async (sid: string) => {
      const goal = goalDraft.trim();
      await api(`/api/sessions/${sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissionMode: autonomyToPermission(autonomyDraft),
          ...(autonomyDraft === 'autonomous' ? { confirmBypass: true } : {}),
          ...(goal ? { goalCondition: goal, goalEnabled: true } : {})
        })
      });
    },
    [autonomyDraft, goalDraft]
  );

  const saveAutonomy = useCallback(
    async (level: AutonomyLevel) => {
      setAutonomyDraft(level);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      await api(`/api/sessions/${sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissionMode: autonomyToPermission(level),
          ...(level === 'autonomous' ? { confirmBypass: true } : {})
        })
      });
      await refreshPlayPanel();
    },
    [selectedSessionRef, refreshPlayPanel]
  );

  const saveTaskMode = useCallback(
    async (next: LabTaskMode) => {
      setTaskMode(next);
      if (next === 'dynamic_workflow') setOrchestrationEngine('ptc');
      else setOrchestrationEngine('legacy');
      const sid = selectedSessionRef.current;
      if (!sid) return;
      await api(`/api/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          orchestrationBody(next, next === 'dynamic_workflow' ? 'ptc' : 'legacy', skillScope)
        )
      });
      await refreshPlayPanel();
    },
    [refreshPlayPanel, selectedSessionRef, skillScope]
  );

  const saveWorkspaceBinding = useCallback(
    async (next: WorkspaceBinding) => {
      setWorkspaceBinding(next);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(sid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workspaceBindingBody(next))
        });
        await refreshPlayPanel();
      } catch (e) {
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [refreshPlayPanel, selectedSessionRef]
  );

  const saveSkillScope = useCallback(
    async (next: LabSkillScope) => {
      setSkillScope(next);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      await api(`/api/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillScope: next })
      });
    },
    [selectedSessionRef]
  );

  const saveOrchestrationEngine = useCallback(
    async (engine: OrchestrationEngine) => {
      setOrchestrationEngine(engine);
      if (engine === 'ptc') setTaskMode('dynamic_workflow');
      const sid = selectedSessionRef.current;
      if (!sid) return;
      await api(`/api/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          orchestrationBody(
            engine === 'ptc' ? 'dynamic_workflow' : taskMode,
            engine,
            skillScope
          )
        )
      });
      await refreshPlayPanel();
    },
    [refreshPlayPanel, selectedSessionRef, taskMode, skillScope]
  );

  const setExecutionMode = useCallback(
    async (nextAgentId: string, nextMode: 'chat' | 'task' = 'chat') => {
      setAgentId(nextAgentId);
      setMode(nextMode);
      const nextEngine = nextMode === 'task' ? orchestrationEngine : 'legacy';
      if (nextMode !== 'task') setOrchestrationEngine('legacy');
      const sid = selectedSessionRef.current;
      if (sid && !playSending && !waitTyping) {
        try {
          await api(`/api/sessions/${sid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: nextAgentId,
              mode: nextMode,
              ...orchestrationBody(taskMode, nextEngine, skillScope)
            }),
          });
          setPlayMeta((prev) => `${nextMode} · ${prev.split(' · ')[1] || 'idle'} · agent=${nextAgentId}`);
        } catch {
          /* ignore non-blocking */
        }
      }
    },
    [orchestrationEngine, playSending, waitTyping, selectedSessionRef, taskMode, skillScope]
  );

  const applyBotSelection = useCallback((bot: BotInfo | null) => {
    if (!bot) {
      botIdRef.current = '';
      setBotId('');
      return;
    }
    botIdRef.current = bot.id;
    setBotId(bot.id);
    setAgentId(bot.agentId);
    setMode('chat');
    setOrchestrationEngine('legacy');
  }, []);

  const openBotSession = useCallback(
    async (id: string): Promise<{ bot: BotInfo; sessionId: string }> => {
      const data = (await api(`/api/bots/${encodeURIComponent(id)}/open`, {
        method: 'POST'
      })) as OpenBotResponse;
      const opened = parseOpenBotResponse(data);
      applyBotSelection(opened.bot);
      upsertBot?.(opened.bot);
      selectedSessionRef.current = opened.sessionId;
      setSelectedSessionId(opened.sessionId);
      return opened;
    },
    [applyBotSelection, selectedSessionRef, setSelectedSessionId, upsertBot]
  );

  const selectBot = useCallback(
    async (id: string) => {
      if (!id) {
        applyBotSelection(null);
        return;
      }
      try {
        onPlaySurfaceChange?.('bot');
        await openBotSession(id);
        requestScrollPlayToBottom();
        sessionListStickTopRef.current = true;
        await tick({ includePlayPanel: true });
      } catch (e) {
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
      }
    },
    [applyBotSelection, onPlaySurfaceChange, openBotSession, requestScrollPlayToBottom, sessionListStickTopRef, tick]
  );

  /**
   * E11: read an SSE stream with bounded retry on transport failure.
   *
   * SSE itself is built for browser auto-reconnect via EventSource, but we use
   * `fetch` (POST body required) which closes on network drop without notice.
   * We retry the POST up to 3 times with 1s / 3s / 10s backoff so a daemon
   * restart or transient blip doesn't strand the chat panel mid-stream.
   *
   * Caveats:
   *   - Only the *initial* request is retried. Once the stream starts emitting,
   *     a mid-stream disconnect raises and shows the user — auto-replaying
   *     would risk double-billing the model.
   *   - Aborted-by-user (composer cleared etc.) is NOT retried.
   */
  const RECONNECT_DELAYS_MS = [1000, 3000, 10000];

  const readSseFetch = async (url: string, body: unknown, onSession?: (id: string) => void) => {
    let res: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RECONNECT_DELAYS_MS.length; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) break;
        // 4xx client errors (except 408/425 which are transient) are terminal:
        // validation failures, rate-limits (429 with Retry-After), auth errors, etc.
        // Surfacing immediately avoids the 14-second blind retry loop.
        if (res.status < 500 && res.status !== 408 && res.status !== 425) {
          // Throw OUTSIDE the try-catch so the loop exits immediately.
          lastErr = new Error(`SSE handshake failed: HTTP ${res.status}`);
          break;
        }
        lastErr = new Error(`SSE handshake HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < RECONNECT_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[attempt]));
      }
    }
    if (!res || !res.ok) {
      throw lastErr ?? new Error('SSE connection failed');
    }
    const segments: StreamSegment[] = [];
    let turnCheckpoint = streamCheckpoint(segments);
    let idCounter = 0;
    const nextId = () => `s-${++idCounter}`;

    const sync = () => {
      setStreamOverlay({ segments: [...segments] });
    };

    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = feedSseBuffer(buf, value, dec, (event, payload) => {
        const p = payload as {
          type?: string;
          text?: string;
          message?: string;
          toolCallId?: string;
          name?: string;
          argumentsFragment?: string;
          surfaceId?: string;
          envelope?: Record<string, unknown>;
          session?: { id: string };
        };
        if (event === 'error') {
          const raw = typeof p.message === 'string' && p.message.trim() ? p.message.trim() : 'stream error';
          throw new PlayStreamError(t('play.status.runFailed', { error: raw }));
        }
        if (event === 'model' && p.type === 'done') {
          turnCheckpoint = streamCheckpoint(segments);
        }
        if (event === 'model' && p.type === 'stream_reset') {
          rollbackToCheckpoint(segments, turnCheckpoint);
          sync();
        }
        if (event === 'model' && p.type === 'text_delta') {
          const delta = p.text ?? '';
          const last = segments[segments.length - 1];
          if (last?.kind === 'text') {
            last.raw += delta;
            last.html = renderMarkdown(last.raw || '…');
          } else {
            segments.push({ kind: 'text', id: nextId(), raw: delta, html: renderMarkdown(delta || '…') });
          }
          sync();
        }
        if (event === 'model' && p.type === 'reasoning_delta') {
          const delta = p.text ?? '';
          const last = segments[segments.length - 1];
          if (last?.kind === 'reasoning') {
            last.text += delta;
          } else {
            segments.push({ kind: 'reasoning', id: nextId(), text: delta });
          }
          sync();
        }
        if (event === 'model' && p.type === 'tool_call_start') {
          const toolCallId = p.toolCallId ?? nextId();
          segments.push({ kind: 'tool', id: nextId(), toolCallId, name: p.name ?? 'unknown', args: '' });
          sync();
        }
        if (event === 'model' && p.type === 'tool_call_delta') {
          const tcid = p.toolCallId ?? '';
          const frag = p.argumentsFragment ?? '';
          for (let i = segments.length - 1; i >= 0; i--) {
            const s = segments[i];
            if (s.kind === 'tool' && s.toolCallId === tcid) {
              s.args += frag;
              break;
            }
          }
          sync();
        }
        if (event === 'model' && p.type === 'a2ui_message' && p.surfaceId && p.envelope) {
          // Coalesce by surfaceId so the streamed surface re-renders in place.
          const existing = segments.find((s) => s.kind === 'a2ui' && s.surfaceId === p.surfaceId);
          // Catalog id is on createSurface; later envelopes carry just surfaceId.
          const csCat = (p.envelope as { createSurface?: { catalogId?: string } }).createSurface?.catalogId;
          if (existing && existing.kind === 'a2ui') {
            if (csCat) existing.catalogId = csCat;
            existing.envelopes.push(p.envelope);
          } else {
            segments.push({
              kind: 'a2ui',
              id: nextId(),
              surfaceId: p.surfaceId,
              catalogId: csCat ?? '',
              envelopes: [p.envelope]
            });
          }
          sync();
        }
        if (event === 'result' && p.session?.id) {
          const sid = p.session.id;
          onSession?.(sid);
          selectedSessionRef.current = sid;
          setSelectedSessionId(sid);
        }
      });
    }
  };

  const ensurePlaySessionForImages = async (): Promise<string> => {
    if (selectedSessionRef.current) return selectedSessionRef.current;
    const activeBotId = playSurface === 'bot' ? botIdRef.current : '';
    if (activeBotId) {
      const opened = await openBotSession(activeBotId);
      requestScrollPlayToBottom();
      sessionListStickTopRef.current = true;
      await tick({ includePlayPanel: true });
      return opened.sessionId;
    }
    const data = (await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        title: mode === 'task' ? t('play.status.newTask') : t('play.status.newSession'),
        agentId: agentId || agents[0]?.id,
        autoRun: false,
        background: false,
        ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
        ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
        ...modelRefBody(modelRefForSend),
        ...workspaceBindingBody(workspaceBinding),
      }),
    })) as { session: { id: string } };
    const sid = data.session.id;
    selectedSessionRef.current = sid;
    setSelectedSessionId(sid);
    await persistPendingStrategy(sid);
    requestScrollPlayToBottom();
    sessionListStickTopRef.current = true;
    await tick({ includePlayPanel: true });
    return sid;
  };

  const sendPlayMessage = async () => {
    const text = playInput.trim();
    const imageAssetIds = [...pendingImageAssetIds];
    const attachmentIds = [...pendingAttachmentIds];
    const commandBotId = playSurface === 'bot' ? botIdRef.current : '';
    if (
      planBotComposerSend({
        botSelected: Boolean(commandBotId),
        text,
        hasAttachments: imageAssetIds.length > 0 || attachmentIds.length > 0
      }) === 'command'
    ) {
      stopSpeechDictation();
      setPlaySending(true);
      try {
        let sid = selectedSessionRef.current;
        if (!sid) {
          sid = (await openBotSession(commandBotId)).sessionId;
        }
        const data = (await api(`/api/sessions/${sid}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, autoRun: false })
        })) as {
          command?: {
            code?: string;
            ok?: boolean;
            arg?: string;
            modelOverride?: { modelId?: string } | null;
          };
        };
        acknowledgeLocalSendCommitted();
        clearComposerOnly();
        clearStreamingShell();
        const status = botComposerStatusText(t, data.command);
        setPlayStatus({ text: status.text, ok: !status.err, err: status.err });
        sessionListStickTopRef.current = true;
        await tick({ includePlayPanel: true });
      } catch (err) {
        setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
      } finally {
        setPlaySending(false);
      }
      return;
    }
    if (workspaceAvailability.blocked) {
      setPlayStatus({
        text: workspaceAvailability.reason || t('play.composer.workspaceBlocked'),
        err: true
      });
      return;
    }
    const running = playSending || Boolean(streamOverlay) || waitTyping;
    if (running) {
      if (!text || !selectedSessionId) return;
      if (steerInterruptPolicy === 'disabled') {
        setPlayStatus({ text: t('play.status.steerDisabled'), err: true });
        return;
      }
      stopSpeechDictation();
      try {
        const target = steerInterruptPolicy === 'queue' ? 'next-run' : 'next-step';
        const execMode = queryExecModeRef.current;
        const data = (await api(`/api/sessions/${selectedSessionId}/steer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, target, ...steerBodyFromQueryMode(execMode) }),
        })) as { ok?: boolean; status?: string; reason?: string; item?: SteerInboxItem };
        acknowledgeLocalSendCommitted();
        clearComposerOnly();
        if (execMode !== 'subagent' && data.item?.id) {
          setSteerInbox((prev) => [
            ...prev,
            { id: data.item!.id, text: data.item!.text || text, target, mode: 'steering' }
          ]);
        }
        if (data.status === 'rejected' || data.status === 'not_submitted') {
          const why =
            data.reason === 'session_ended'
              ? t('play.status.sessionEnded')
              : data.reason === 'no_session'
                ? t('play.status.noSession')
                : data.reason === 'steer_disabled'
                  ? t('play.status.steerDisabled')
                  : data.reason || t('play.status.notAccepted');
          setPlayStatus({ text: t('play.status.notAcceptedWhy', { why }), err: true });
        } else if (execMode === 'subagent') {
          setPlayStatus({ text: t('play.status.queuedSubagent'), ok: true });
        } else if (data.status === 'queued') {
          setPlayStatus({
            text: steerInterruptPolicy === 'queue' ? t('play.status.queuedEnd') : t('play.status.queuedNext'),
            ok: true
          });
        } else {
          setPlayStatus({ text: t('play.status.steered'), ok: true });
        }
      } catch (err) {
        setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
      }
      return;
    }
    stopSpeechDictation();
    if (!text && imageAssetIds.length === 0 && attachmentIds.length === 0) return;
    const draftSnapshot = playInput;
    const imageSnapshot = [...pendingImageAssetIds];
    const attachmentSnapshot = [...pendingAttachmentIds];
    setPlayStatus({ text: '' });
    setPlaySending(true);

    const preview = userPreviewText(text || '(image)', imageAssetIds);
    const beginStreamTurn = () => {
      acknowledgeLocalSendCommitted();
      requestScrollPlayToBottom();
      setOptimisticUser(preview);
      setStreamOverlay({ segments: [] });
      clearComposerOnly();
    };
    const beginWaitTurn = () => {
      acknowledgeLocalSendCommitted();
      requestScrollPlayToBottom();
      setOptimisticUser(preview);
      setWaitTyping(true);
      clearComposerOnly();
    };

    try {
      const activeBotId = playSurface === 'bot' ? botIdRef.current : '';
      const hadSession = Boolean(selectedSessionRef.current);
      let sid = selectedSessionId;
      if (!sid && activeBotId) {
        const opened = await openBotSession(activeBotId);
        sid = opened.sessionId;
      }
      if (sid) {
        if (useStream) {
          beginStreamTurn();
          await readSseFetch(
            `/api/sessions/${sid}/stream`,
            {
              message: text || '(attachment)',
              imageAssetIds,
              attachmentIds,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            },
            undefined
          );
        } else {
          beginWaitTurn();
          await api(`/api/sessions/${sid}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text || '(attachment)',
              imageAssetIds,
              attachmentIds,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            }),
          });
        }
        clearStreamingShell();
        setPlayStatus({ text: t('play.status.sent'), ok: true });
      } else if (activeBotId) {
        throw new Error(t('play.status.openBotFailed'));
      } else if (mode === 'chat') {
        if (useStream) {
          beginStreamTurn();
          await readSseFetch('/api/chat/stream', {
            message: text || '(attachment)',
            title: (text || t('play.attachment')).slice(0, 60),
            agentId: agentId || agents[0]?.id,
            imageAssetIds,
            attachmentIds,
            ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
            ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
            ...modelRefBody(modelRefForSend),
            ...workspaceBindingBody(workspaceBinding),
          });
          clearStreamingShell();
          setPlayStatus({ text: t('play.status.streamDone'), ok: true });
        } else {
          beginWaitTurn();
          const data = (await api('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text || '(attachment)',
              title: (text || t('play.attachment')).slice(0, 60),
              agentId: agentId || agents[0]?.id,
              imageAssetIds,
              attachmentIds,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            }),
          })) as { session: { id: string } };
          const newSid = data.session.id;
          selectedSessionRef.current = newSid;
          setSelectedSessionId(newSid);
          clearStreamingShell();
          await refreshPlayPanel();
          setPlayStatus({ text: t('play.status.sessionCreated'), ok: true });
        }
      } else {
        beginWaitTurn();
        const data = (await api('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'task',
            title: text.slice(0, 80),
            message: text || '(attachment)',
            imageAssetIds,
            attachmentIds,
            agentId: agentId || agents[0]?.id,
            autoRun: true,
            background: true,
            ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
            ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
            ...modelRefBody(modelRefForSend),
            ...workspaceBindingBody(workspaceBinding),
          }),
        })) as { session: { id: string } };
        const newSid = data.session.id;
        selectedSessionRef.current = newSid;
        setSelectedSessionId(newSid);
        clearStreamingShell();
        await refreshPlayPanel();
        setPlayStatus({ text: t('play.status.taskCreated'), ok: true });
      }
      if (!hadSession && !activeBotId && selectedSessionRef.current) {
        await persistPendingStrategy(selectedSessionRef.current);
      }
      sessionListStickTopRef.current = true;
      await tick({ includePlayPanel: true });
    } catch (e) {
      setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
      const persisted = e instanceof PlayStreamError && e.persisted;
      if (!persisted) {
        setPlayInput(draftSnapshot);
        setPendingImageAssetIds(imageSnapshot);
        setPendingAttachmentIds(attachmentSnapshot);
      }
      clearStreamingShell();
      if (persisted) {
        await tick({ includePlayPanel: true });
      }
    } finally {
      setPlaySending(false);
    }
  };

  const handleFileUpload = async (files: FileList) => {
    try {
      const sid = await ensurePlaySessionForImages();
      const imgIds = [...pendingImageAssetIds];
      const attIds = [...pendingAttachmentIds];
      for (const file of files) {
        const b64 = await fileToBase64Data(file);
        const data = (await api(`/api/sessions/${sid}/attachments/ingest-base64`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataBase64: b64,
            mimeType: file.type || undefined,
            fileName: file.name,
          }),
        })) as {
          attachment?: { id?: string; imageAssetId?: string };
          imageAsset?: { id?: string };
        };
        if (data.attachment?.id) attIds.push(data.attachment.id);
        const assetId = data.attachment?.imageAssetId || data.imageAsset?.id;
        if (assetId) imgIds.push(assetId);
      }
      setPendingImageAssetIds(imgIds);
      setPendingAttachmentIds(attIds);
      setPlayStatus({ text: t('play.status.addedFiles', { count: files.length }), ok: true });
      await tick({ includePlayPanel: true });
    } catch (err) {
      setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
    }
  };

  const handleUrlFetch = async () => {
    const url = imageUrlInput.trim();
    if (!url) return;
    try {
      const sid = await ensurePlaySessionForImages();
      const data = (await api(`/api/sessions/${sid}/attachments/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })) as {
        attachment?: { id?: string; imageAssetId?: string };
        imageAsset?: { id?: string };
      };
      if (data.attachment?.id) {
        setPendingAttachmentIds((x) => [...x, data.attachment!.id!]);
      }
      const assetId = data.attachment?.imageAssetId || data.imageAsset?.id;
      if (assetId) setPendingImageAssetIds((x) => [...x, assetId]);
      setImageUrlInput('');
      setPlayStatus({ text: t('play.status.addedRemote'), ok: true });
      await tick({ includePlayPanel: true });
    } catch (err) {
      setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
    }
  };

  // Follow new output only while the reader remains anchored to the latest message.
  // Any upward wheel/scroll disables this until they explicitly return to the bottom.
  useLayoutEffect(() => {
    if (!playStickToBottomRef.current) return;
    scrollPlayToBottom();
    scheduleScrollPlayToBottom();
  }, [
    sessionMessages,
    streamOverlay,
    optimisticUser,
    waitTyping,
    scheduleScrollPlayToBottom,
    scrollPlayToBottom,
  ]);

  return {
    // State
    sessionMessages,
    playTitle,
    playMeta,
    sessionChrome,
    goalDraft,
    setGoalDraft,
    saveGoalCondition,
    saveAutonomy,
    autonomyLevel: sessionChrome
      ? permissionToAutonomy(sessionChrome.permissionMode)
      : autonomyDraft,
    playInput,
    setPlayInput,
    imageUrlInput,
    setImageUrlInput,
    pendingImageAssetIds,
    setPendingImageAssetIds,
    pendingAttachmentIds,
    setPendingAttachmentIds,
    sessionFileArtifacts,
    playStatus,
    setPlayStatus,
    optimisticUser,
    streamOverlay,
    waitTyping,
    playSending,
    composerAckFlash,
    speechDictationAvailable,
    speechDictating,
    toggleSpeechDictation,
    mode,
    setMode,
    orchestrationEngine,
    saveOrchestrationEngine,
    taskMode,
    skillScope,
    taskModeBound,
    saveTaskMode,
    workspaceBinding,
    workspaceBindingBound,
    workspaceAvailability,
    setWorkspaceAvailability,
    saveWorkspaceBinding,
    saveSkillScope,
    agentId,
    setAgentId,
    setExecutionMode,
    botId,
    botModelOverride,
    applyBotSelection,
    selectBot,
    modelOptions,
    modelRef,
    modelCatalog,
    needsModelSetup: catalogNeedsSetup(modelCatalog),
    applyModelCatalog,
    saveModelRef,
    encodeModelValue,
    decodeModelValue,
    useStream,
    setUseStream,
    showModelView,
    setShowModelView,
    modelViewPayload,
    showJumpToLatest,
    displayMessages:
      showModelView && modelViewPayload?.modelView ? modelViewPayload.modelView : sessionMessages,
    optionalToolGroupsFeature,
    optionalToolCatalog,
    enabledOptionalGroupIds,
    toggleOptionalGroup,
    steerInterruptPolicy,
    saveSteerInterruptPolicy,
    steerInbox,
    steerPolicyBusy,
    queryExecMode,
    setQueryExecMode,
    updateSteerItem,
    dropSteerItem,
    setSteerItemMode,
    // Refs
    playMessagesRef,
    playInputRef,
    // Methods
    handlePlayMessagesScroll,
    refreshPlayPanel,
    requestScrollPlayToBottom,
    sendPlayMessage,
    handleFileUpload,
    handleUrlFetch,
    setPlayTitle,
    setPlayMeta,
    setSessionMessages,
  };
}

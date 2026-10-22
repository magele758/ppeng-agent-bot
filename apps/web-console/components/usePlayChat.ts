'use client';
import { goalMessage } from '@/lib/bot-goals';
import { noteBotFirstTaskSent } from '@/lib/bot-first-task';

import { botComposerStatusText, planBotComposerSend } from '@/lib/bot-chat-commands';
import { parseBotModelOverride, resolveLoadedComposerModelRef } from '@/lib/bot-model';
import { resolveComposerAgentId } from '@/lib/default-agent';
import {
  canRequestOlderPage,
  nextTranscriptWindow,
  pageEpochCurrent,
  planFeedScroll,
  readFeedAnchor,
  sessionFeedSearch,
  showLatestWhenStuck,
  steerPrefixCount,
  type FeedScrollIntent
} from '@/lib/feed-window';
import { prependHistoryPage } from '@/lib/history-window';
import { api } from '@/lib/api';
import { loadSessionPanelResource, transcriptModelView } from '@/lib/session-panel-resource';
import { readRetryProgress, type RetryProgress } from '@/lib/model-retry';
import { modelErrorText } from '@/lib/model-errors';
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from '@/lib/speech-dictation';
import { renderMarkdown } from '@/lib/markdown';
import { rollbackToCheckpoint, streamCheckpoint, type StreamSegment } from '@/lib/stream-segments';
import { feedSseBuffer } from '@/lib/sse';
import { liveSessionFollowRequest, type LiveStreamArm } from '@/lib/live-stream-attach';
import { shouldResumeRunningTurn } from '@/lib/run-leave';
import {
  applyWhen,
  assertSameSession,
  detachLiveTurn,
  generationForArm,
  handleSteerFailure,
  liveTurnBelongsToSelection,
  liveTurnIsRunning,
  liveTurnOwnerId,
  mayClaimSelectedSession,
  canFollowSession,
  ownsLiveTurn,
  releaseArmOwner,
  releaseIfCurrent,
  reportOwnedError,
  restoreComposerUnlessPersisted,
  resultSessionId,
  runIf,
  screenLiveTurn,
  steerUiAfterSend,
  shouldSkipForeignLiveArm,
  shouldSurfaceLiveArmError,
  shouldTickLiveArm,
  streamOverlayVisible,
  streamPaintApplies,
  botOpenApplies,
  visibleStream,
  liveTurnRunning,
  steerResponseApplies,
  UNBOUND_LIVE_TURN,
  streamSessionAllowed,
  tickIfPersisted,
  visibleLiveOverlay,
} from '@/lib/live-turn-session';
import { userPreviewText } from '@/lib/chat-utils';
import {
  emptyReplyQuoteMemory,
  forgetPendingReply,
  rememberPendingReply,
  stampReplyQuotes,
  withReplyTo,
  type ReplyQuote
} from '@/lib/reply-quote';
import {
  contextLabelsOf,
  composerHasAttachments,
  contextSubmission,
  contextSourcesBody,
  contextSourcesForSend,
  type ContextLabel,
} from '@/lib/composer-context';
import { usePendingComposerContext } from './ComposerContext';
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
import { decideRunningTurnSend, isCanonicalBotChatMetadata, planRunningTurnDelivery } from '@/lib/running-turn-send';
import {
  applyGhostKey,
  emptyGhost,
  ghostFromSuggestion,
  ghostText,
  suggestionStillCurrent,
  type GhostState,
  type InputSuggestion
} from '@/lib/input-suggestion';
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

function messageId(message: ChatMessage): string {
  const id = (message as ChatMessage & { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function messageUserText(message: ChatMessage): string {
  const parts = message.parts ?? [];
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push(part.text);
  }
  return lines.join('\n');
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

function activeFollowMatches(follow: { sessionId: string; controller: AbortController; ready: Promise<void> } | null,
  sessionId: string): boolean {
  return follow?.sessionId === sessionId && !follow.controller.signal.aborted;
}

function isSessionResult(event: string, payload: { session?: { id?: string } }): payload is { session: { id: string } } {
  return (event === 'result' || event === 'session') && Boolean(payload.session?.id);
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

  const [historyCursor,setHistoryCursor]=useState<number|null>(null);
  const historyCursorRef = useRef<number | null>(null);
  historyCursorRef.current = historyCursor;
  const [historyLoading,setHistoryLoading]=useState(false);
  const historySessionRef=useRef('');
  const historyLoadingRef = useRef(false);
  const historyAutoBlockedRef = useRef(false);
  const feedEpochRef = useRef(0);
  const feedScrollIntentRef = useRef<FeedScrollIntent | null>(null);
  const [feedRevision, setFeedRevision] = useState(0);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const historyMessagesRef=useRef<ChatMessage[]>([]);
  historyMessagesRef.current=sessionMessages;
  const [playTitle, setPlayTitle] = useState(t('play.empty.selectOrCreateSession'));
  const [playMeta, setPlayMeta] = useState('');
  const [sessionChrome, setSessionChrome] = useState<SessionChromeMeta | null>(null);
  const [goalDraft, setGoalDraft] = useState('');
  const [autonomyDraft, setAutonomyDraft] = useState<AutonomyLevel>('balanced');
  const [playInput, setPlayInput] = useState('');
  const [inputGhost, setInputGhost] = useState<GhostState>(emptyGhost);
  const [suggestionEnabled, setSuggestionEnabled] = useState(true);
  const suggestionReqRef = useRef(0);
  const suggestionSessionRef = useRef<string | null>(null);
  const requestInputSuggestionRef = useRef<(sessionId: string) => Promise<void>>(async () => undefined);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [imageUrlInput, setImageUrlInput] = useState('');
  const [pendingImageAssetIds, setPendingImageAssetIds] = useState<string[]>([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
  const [sessionFileArtifacts, setSessionFileArtifacts] = useState<
    Array<{ id: string; title?: string; handle?: string }>
  >([]);
  const [playStatus, setPlayStatus] = useState<{ text: string; ok?: boolean; err?: boolean }>({ text: '' });
  const [optimisticUser, setOptimisticUser] = useState<string | null>(null);
  const [optimisticContext, setOptimisticContext] = useState<ContextLabel[]>([]);
  const [optimisticReply, setOptimisticReply] = useState<ReplyQuote | null>(null);
  const [replyQuote, setReplyQuote] = useState<ReplyQuote | null>(null);
  const replyQuoteRef = useRef<ReplyQuote | null>(null);
  const replyMemoryRef = useRef(emptyReplyQuoteMemory());
  replyQuoteRef.current = replyQuote;
  const { pendingContext, setPendingContext, addPendingContext } = usePendingComposerContext(() => {
    setPlayStatus({ text: t('play.composer.contextTruncated') });
  });
  const [streamOverlay, setStreamOverlay] = useState<{ segments: StreamSegment[]; retry?: RetryProgress } | null>(null);
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
  const [agentId, setAgentId] = useState('general');
  const [botId, setBotId] = useState('');
  useEffect(() => { setSelectedGoalId(null); }, [botId, selectedSessionId]);
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
  const [immediateSteer, setImmediateSteer] = useState(false);
  const immediateSteerRef = useRef(false);
  const canonicalBotChatRef = useRef(false);
  const canonicalBotChatKnownRef = useRef(false);
  const canonicalForSessionRef = useRef<string | null>(null);
  const pendingSteerTextRef = useRef<string | null>(null);
  const pendingSteerSessionRef = useRef<string | null>(null);
  const pendingSteerKnownIdsRef = useRef<Set<string>>(new Set());
  const streamSegmentsRef = useRef<StreamSegment[]>([]);
  const modelShotOpenRef = useRef(false);
  const steerSplitRef = useRef<{ prefix: number; holdOpen: boolean } | null>(null);
  const [steerSplit, setSteerSplit] = useState<{ prefix: number; holdOpen: boolean } | null>(null);
  const [steerInbox, setSteerInbox] = useState<SteerInboxItem[]>([]);
  const [steerPolicyBusy, setSteerPolicyBusy] = useState(false);
  const [queryExecMode, setQueryExecMode] = useState<QueryExecMode>('steering');

  const playMessagesRef = useRef<HTMLDivElement>(null);
  const playSendingLiveRef = useRef(false);
  playSendingLiveRef.current = playSending;
  const [chromeSessionId, setChromeSessionId] = useState<string | null>(null);
  const liveFollowRef = useRef<{
    sessionId: string;
    controller: AbortController;
    ready: Promise<void>;
  } | null>(null);
  const liveOwnerRef = useRef<string | null>(null);
  const liveGenRef = useRef(0);
  const botOpenRequestRef = useRef(0);
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

  const clearInputSuggestion = () => setInputGhost(emptyGhost());

  const clearComposerOnly = () => {
    setPlayInput('');
    setPendingImageAssetIds([]);
    setPendingAttachmentIds([]);
    setPendingContext([]);
    clearInputSuggestion();
  };

  const inputGhostRef = useRef(inputGhost);
  inputGhostRef.current = inputGhost;

  const acceptInputSuggestion = () => {
    const next = applyGhostKey(inputGhostRef.current, 'Tab', playInputLiveRef.current);
    if (next.commit === undefined) return false;
    playInputLiveRef.current = next.commit;
    setPlayInput(next.commit);
    setInputGhost(next.state);
    return true;
  };

  const dismissInputSuggestion = () => {
    if (!ghostText(inputGhostRef.current)) return false;
    setInputGhost(emptyGhost());
    return true;
  };

  const removePendingContext = (id: string) => {
    setPendingContext((current) => current.filter((item) => item.id !== id));
  };

  const composerIsCanonicalBot = () => {
    const sid = selectedSessionRef.current;
    if (canonicalBotChatKnownRef.current && canonicalForSessionRef.current === sid) {
      return canonicalBotChatRef.current;
    }
    return playSurface === 'bot' && Boolean(botIdRef.current) && Boolean(sid);
  };

  const publishImmediateSteer = () => {
    const steer = decideRunningTurnSend({ canonicalBotChat: composerIsCanonicalBot() }) === 'steer';
    immediateSteerRef.current = steer;
    setImmediateSteer(steer);
  };

  const rememberCanonicalBotChat = (sid: string | null, session?: { mode?: string; metadata?: Record<string, unknown> | null }) => {
    if (!sid || !session) {
      canonicalBotChatKnownRef.current = false;
      canonicalBotChatRef.current = false;
      canonicalForSessionRef.current = null;
      publishImmediateSteer();
      return;
    }
    canonicalBotChatKnownRef.current = true;
    canonicalForSessionRef.current = sid;
    canonicalBotChatRef.current = isCanonicalBotChatMetadata(session);
    publishImmediateSteer();
  };

  const publishSteerSplit = (split: { prefix: number; holdOpen: boolean } | null) => {
    steerSplitRef.current = split;
    setSteerSplit(split);
  };
  const clearSteerSplit = () => {
    if (!steerSplitRef.current) return;
    publishSteerSplit(null);
  };
  const anchorSteerSplit = () => {
    publishSteerSplit({
      prefix: streamSegmentsRef.current.length,
      holdOpen: modelShotOpenRef.current
    });
  };
  const clearStreamingShell = () => {
    if (!pendingSteerTextRef.current) {
      setOptimisticUser(null);
      setOptimisticContext([]);
      setOptimisticReply(null);
      clearSteerSplit();
    }
    streamSegmentsRef.current = [];
    modelShotOpenRef.current = false;
    setStreamOverlay(null);
    setWaitTyping(false);
  };

  const claimLiveTurn = (sessionId: string) => {
    const generation = liveGenRef.current + 1;
    liveGenRef.current = generation;
    liveOwnerRef.current = sessionId;
    return generation;
  };

  const liveTurnCurrent = (generation: number) => streamPaintApplies(liveGenRef.current, generation);

  const liveTurnOnScreen = (generation: number) =>
    liveTurnCurrent(generation) && liveTurnBelongsToSelection(liveOwnerRef.current, selectedSessionRef.current);

  const assertSessionClaim = (generation: number, sessionId: string) => {
    if (!mayClaimSelectedSession(liveGenRef.current, generation, selectedSessionRef.current, sessionId)) {
      throw new Error('Detached session selection');
    }
  };

  const assertLiveTurn = (generation: number) => {
    if (!liveTurnCurrent(generation)) throw new Error('Detached live turn');
  };

  const finishLiveTurn = (generation: number) => {
    if (!liveTurnCurrent(generation)) return;
    liveOwnerRef.current = null;
    clearStreamingShell();
    setPlaySending(false);
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

    if (userMovedUp || currentTop <= 1) {
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

  useLayoutEffect(() => {
    playStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    const follow = liveFollowRef.current;
    if (follow && follow.sessionId !== selectedSessionId) follow.controller.abort();
    const detached = detachLiveTurn(
      { generation: liveGenRef.current, liveSessionId: liveOwnerRef.current },
      selectedSessionId
    );
    if (!detached.detached) return;
    liveGenRef.current = detached.generation;
    liveOwnerRef.current = detached.liveSessionId;
    pendingSteerTextRef.current = null;
    pendingSteerSessionRef.current = null;
    clearStreamingShell();
    setPlaySending(false);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await api('/api/input-suggestion/settings')) as {
          settings?: { enabled?: boolean };
        };
        if (!cancelled && typeof data.settings?.enabled === 'boolean') {
          setSuggestionEnabled(data.settings.enabled);
        }
      } catch {
        /* default on */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestInputSuggestion = useCallback(async (sessionId: string) => {
    if (playSurface !== 'bot' || !suggestionEnabled) {
      setInputGhost(emptyGhost());
      return;
    }
    if (playInputLiveRef.current.trim()) return;
    const requestId = suggestionReqRef.current + 1;
    suggestionReqRef.current = requestId;
    suggestionSessionRef.current = sessionId;
    const issued = { requestId, sessionId };
    try {
      const data = (await api(`/api/sessions/${sessionId}/input-suggestion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      })) as { suggestion?: InputSuggestion | null; enabled?: boolean };
      if (typeof data.enabled === 'boolean') setSuggestionEnabled(data.enabled);
      const current = { requestId: suggestionReqRef.current, sessionId: suggestionSessionRef.current ?? '' };
      if (!suggestionStillCurrent(issued, current)) return;
      if (playInputLiveRef.current.trim()) return;
      setInputGhost(ghostFromSuggestion(data.suggestion));
    } catch {
      const current = { requestId: suggestionReqRef.current, sessionId: suggestionSessionRef.current ?? '' };
      if (suggestionStillCurrent(issued, current)) setInputGhost(emptyGhost());
    }
  }, [playSurface, suggestionEnabled]);

  requestInputSuggestionRef.current = requestInputSuggestion;

  useEffect(() => {
    suggestionReqRef.current += 1;
    suggestionSessionRef.current = selectedSessionId;
    setInputGhost(emptyGhost());
  }, [selectedSessionId]);

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
    setModelRef((cur) => cur ? resolvePickerModelRef(pickerOptions, cur) : null);
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
    setReplyQuote(null);
    setOptimisticReply(null);
    replyMemoryRef.current = emptyReplyQuoteMemory();
  }, [playSurface, botId, selectedSessionId]);

  const quoteReply = (quote: ReplyQuote) => setReplyQuote(quote);
  const cancelReplyQuote = () => setReplyQuote(null);

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
    async (next: ModelRef | null) => {
      const sid = selectedSessionRef.current;
      try {
        if (sid) {
          await api(`/api/sessions/${encodeURIComponent(sid)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelRef: next })
          });
        }
        setModelRef(next);
      } catch (e) {
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
      }
    },
    [selectedSessionRef]
  );

  const refreshPlayPanel = useCallback(async () => {
    const sid = selectedSessionRef.current;
    if (!sid) {
      setChromeSessionId(null);
      historySessionRef.current='';
      historyAutoBlockedRef.current = false;
      setHistoryCursor(null);
      rememberCanonicalBotChat(null);
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
    const epoch = ++feedEpochRef.current;
    try {
      const data = (await api(`/api/sessions/${sid}?${sessionFeedSearch()}`)) as {
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
        hasMore?:boolean;nextCursor?:number|null;
        inbox?: SteerInboxItem[];
      };
      if (!pageEpochCurrent(selectedSessionRef.current, sid, feedEpochRef.current, epoch)) return;
      feedEpochRef.current = epoch + 1;
      rememberCanonicalBotChat(sid, data.session);
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
      setChromeSessionId(sid);
      setSessionChrome(chrome);
      setGoalDraft(chrome.goalCondition ?? '');
      setAutonomyDraft(permissionToAutonomy(chrome.permissionMode));
      setBotModelOverride(parseBotModelOverride(data.session.metadata));
      const switching = historySessionRef.current !== sid;
      if (switching) historyAutoBlockedRef.current = false;
      const incoming = (data.messages ?? []) as Array<ChatMessage & { id: string; seq?: number }>;
      const planned = nextTranscriptWindow({
        sameSession: !switching,
        previous: historyMessagesRef.current as Array<ChatMessage & { id: string; seq?: number }>,
        incoming,
        hasMore: data.hasMore === true,
        nextCursor: data.nextCursor ?? null,
        previousCursor: historyCursorRef.current,
        stick: playStickToBottomRef.current,
        anchor: readFeedAnchor(playMessagesRef.current)
      });
      historySessionRef.current = sid;
      playStickToBottomRef.current = planned.stick;
      showLatestWhenStuck(planned.stick, setShowJumpToLatest);
      feedScrollIntentRef.current = planned.intent;
      setSessionMessages(stampReplyQuotes(planned.messages, replyMemoryRef.current));
      setHistoryCursor(planned.cursor);
      setFeedRevision((revision) => revision + 1);
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
      const panelCurrent = () => pageEpochCurrent(selectedSessionRef.current, sid, feedEpochRef.current, epoch + 1);
      await loadSessionPanelResource<SessionModelViewPayload | null>(
        async () => showModelView ? await api(`/api/sessions/${sid}/model-view`) as SessionModelViewPayload : null,
        panelCurrent, setModelViewPayload, null
      );
      await loadSessionPanelResource(
        async () => {
          const arts = await api(`/api/sessions/${sid}/artifacts`) as { artifacts?: Array<{ id: string; title?: string; fileName?: string }> };
          return (arts.artifacts ?? []).map(a => ({ id: a.id, title: a.title || a.fileName, handle: a.id }));
        },
        panelCurrent, setSessionFileArtifacts, []
      );
    } catch {
      if (!pageEpochCurrent(selectedSessionRef.current, sid, feedEpochRef.current, epoch)) return;
      setChromeSessionId(null);
      historySessionRef.current = '';
      setHistoryCursor(null);
      rememberCanonicalBotChat(null);
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
  }, [playSurface, selectedSessionRef, showModelView, t]);

  useEffect(() => {
    const live = playSending || Boolean(streamOverlay) || waitTyping;
    if (!live) return;
    const sid = selectedSessionRef.current;
    if (!sid) return;
    let cancelled = false;
    const pullChrome = async () => {
      try {
        const data = (await api(`/api/sessions/${sid}?includeMessages=false`)) as {
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

  useEffect(() => {
    publishImmediateSteer();
  }, [playSurface, botId, selectedSessionId]);

  useEffect(() => {
    const wanted = pendingSteerTextRef.current;
    if (!wanted || !optimisticUser) return;
    const sid = selectedSessionRef.current;
    if (!sid) return;
    let cancelled = false;
    const look = async () => {
      try {
        const data = (await api(`/api/sessions/${sid}?${sessionFeedSearch()}`)) as { messages?: ChatMessage[] };
        if (cancelled || pendingSteerTextRef.current !== wanted) return;
        const known = pendingSteerKnownIdsRef.current;
        const landed = (data.messages ?? []).some((message) => {
          const id = messageId(message);
          return message.role === 'user' && id && !known.has(id) && messageUserText(message).includes(wanted);
        });
        if (!landed) return;
        pendingSteerTextRef.current = null;
        pendingSteerSessionRef.current = null;
        clearSteerSplit();
        setOptimisticUser(null);
        setOptimisticContext([]);
        setOptimisticReply(null);
        await refreshPlayPanel();
      } catch {
        /* steer landing is best-effort */
      }
    };
    void look();
    const timer = setInterval(() => void look(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [optimisticUser, selectedSessionId, refreshPlayPanel, selectedSessionRef]);

  const saveGoalCondition = useCallback(
    async (condition: string) => {
      const sid = selectedSessionRef.current;
      if (!sid) return;
      const cond = condition.trim();
      try {
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
      } catch (e) {
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [refreshPlayPanel, selectedSessionRef]
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
      const previous = autonomyDraft;
      setAutonomyDraft(level);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      try {
        await api(`/api/sessions/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            permissionMode: autonomyToPermission(level),
            ...(level === 'autonomous' ? { confirmBypass: true } : {})
          })
        });
        await refreshPlayPanel();
      } catch (e) {
        setAutonomyDraft(previous);
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [autonomyDraft, refreshPlayPanel, selectedSessionRef]
  );

  const saveTaskMode = useCallback(
    async (next: LabTaskMode) => {
      const previousMode = taskMode;
      const previousEngine = orchestrationEngine;
      setTaskMode(next);
      const nextEngine = next === 'dynamic_workflow' ? 'ptc' : 'legacy';
      setOrchestrationEngine(nextEngine);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(sid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orchestrationBody(next, nextEngine, skillScope))
        });
        await refreshPlayPanel();
      } catch (e) {
        setTaskMode(previousMode);
        setOrchestrationEngine(previousEngine);
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [orchestrationEngine, refreshPlayPanel, selectedSessionRef, skillScope, taskMode]
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
      const previous = skillScope;
      setSkillScope(next);
      const sid = selectedSessionRef.current;
      if (!sid) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(sid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skillScope: next })
        });
      } catch (e) {
        setSkillScope(previous);
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [refreshPlayPanel, selectedSessionRef, skillScope]
  );

  const saveOrchestrationEngine = useCallback(
    async (engine: OrchestrationEngine) => {
      const previousEngine = orchestrationEngine;
      const previousMode = taskMode;
      setOrchestrationEngine(engine);
      const nextMode = engine === 'ptc' ? 'dynamic_workflow' : taskMode;
      if (engine === 'ptc') setTaskMode('dynamic_workflow');
      const sid = selectedSessionRef.current;
      if (!sid) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(sid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orchestrationBody(nextMode, engine, skillScope))
        });
        await refreshPlayPanel();
      } catch (e) {
        setOrchestrationEngine(previousEngine);
        setTaskMode(previousMode);
        setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
        await refreshPlayPanel();
      }
    },
    [orchestrationEngine, refreshPlayPanel, selectedSessionRef, skillScope, taskMode]
  );

  const setExecutionMode = useCallback(
    async (nextAgentId: string, nextMode: 'chat' | 'task' = 'chat') => {
      const previousAgent = agentId;
      const previousMode = mode;
      const previousEngine = orchestrationEngine;
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
        } catch (e) {
          setAgentId(previousAgent);
          setMode(previousMode);
          setOrchestrationEngine(previousEngine);
          setPlayStatus({ text: e instanceof Error ? e.message : String(e), err: true });
          await refreshPlayPanel();
        }
      }
    },
    [agentId, mode, orchestrationEngine, playSending, refreshPlayPanel, selectedSessionRef, skillScope, taskMode, waitTyping]
  );

  const toggleModelView=async(show:boolean)=>{setShowModelView(show);if(!show)return;const sid=selectedSessionRef.current;if(!sid)return;try{const data=await api(`/api/sessions/${sid}/model-view`) as SessionModelViewPayload;if(selectedSessionRef.current===sid)setModelViewPayload(data);}catch(error){setPlayStatus({text:String(error),err:true});}};

  const loadOlderHistory = async (reason: 'scroll' | 'auto' = 'scroll') => {
    const sid = selectedSessionRef.current;
    const cursor = historyCursorRef.current;
    if (!canRequestOlderPage({
      sessionId: sid,
      cursor,
      loading: historyLoadingRef.current,
      reason,
      blocked: historyAutoBlockedRef.current,
      loadedSessionId: historySessionRef.current
    })) return;
    const epoch = feedEpochRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    try {
      const data = (await api(`/api/sessions/${sid}?${sessionFeedSearch(cursor)}`)) as {
        messages: ChatMessage[];
        hasMore: boolean;
        nextCursor: number | null;
      };
      if (!pageEpochCurrent(selectedSessionRef.current, sid!, epoch, feedEpochRef.current, historySessionRef.current)) return;
        const older = (data.messages ?? []) as Array<ChatMessage & { id: string }>;
      const planned = planFeedScroll('prepend', playStickToBottomRef.current, readFeedAnchor(playMessagesRef.current));
      playStickToBottomRef.current = planned.stick;
      showLatestWhenStuck(planned.stick, setShowJumpToLatest);
      feedScrollIntentRef.current = planned.intent;
      setSessionMessages((prev) =>
        stampReplyQuotes(prependHistoryPage(prev as Array<ChatMessage & { id: string }>, older), replyMemoryRef.current)
      );
      setHistoryCursor(data.hasMore ? data.nextCursor : null);
      historyAutoBlockedRef.current = false;
      setFeedRevision((revision) => revision + 1);
    } catch (error) {
      historyAutoBlockedRef.current = true;
      setPlayStatus({ text: String(error), err: true });
    } finally {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    }
  };

  const applyBotSelection = useCallback((bot: BotInfo | null) => {
    if (!bot) {
      botIdRef.current = '';
      setBotId('');
      return;
    }
    try { localStorage.setItem('lab.selectedBot', bot.id); } catch {}
    botIdRef.current = bot.id;
    setBotId(bot.id);
    setAgentId(bot.agentId);
    setMode('chat');
    setOrchestrationEngine('legacy');
  }, []);

  const openBotSession = useCallback(
    async (id: string, adopt?: { liveGen: number }): Promise<{ bot: BotInfo; sessionId: string }> => {
      const requestId = ++botOpenRequestRef.current;
      const selectedAtStart = selectedSessionRef.current;
      const generation = adopt?.liveGen ?? liveGenRef.current;
      const data = (await api(`/api/bots/${encodeURIComponent(id)}/open`, {
        method: 'POST'
      })) as OpenBotResponse;
      const opened = parseOpenBotResponse(data);
      if (!botOpenApplies(requestId, botOpenRequestRef.current, selectedAtStart, selectedSessionRef.current, liveTurnCurrent(generation))) return opened;
      applyBotSelection(opened.bot);
      upsertBot?.(opened.bot);
      if (adopt) {
        liveOwnerRef.current = opened.sessionId;
      }
      selectedSessionRef.current = opened.sessionId;
      setSelectedSessionId(opened.sessionId);
      return opened;
    },
    [applyBotSelection, selectedSessionRef, setSelectedSessionId, upsertBot]
  );

  const selectBot = useCallback(
    async (id: string) => {
      // Invalidate pending opens and stream callbacks as soon as selection is requested.
      botOpenRequestRef.current += 1;
      liveGenRef.current += 1;
      liveOwnerRef.current = null;
      pendingSteerTextRef.current = null;
      pendingSteerSessionRef.current = null;
      clearStreamingShell();
      setPlaySending(false);
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

  const readSseFetch = async (
    url: string,
    body: unknown,
    onSession: ((id: string) => void) | undefined,
    opts: { onReady?: () => void; signal?: AbortSignal; extraAttempts?: number; liveGen: number }
  ) => {
    const streamGeneration = opts.liveGen;
    const throwIfAborted = () => {
      if (opts?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    };
    const isAbort = (err: unknown) =>
      opts?.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    let res: Response | undefined;
    let lastErr: unknown;
    const extraAttempts = opts?.extraAttempts ?? RECONNECT_DELAYS_MS.length;
    for (let attempt = 0; attempt <= extraAttempts; attempt++) {
      throwIfAborted();
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts?.signal
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
        if (isAbort(err)) throw err;
        lastErr = err;
      }
      if (attempt < extraAttempts) {
        await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]));
      }
    }
    if (!res || !res.ok) {
      throw lastErr ?? new Error('SSE connection failed');
    }
    const segments: StreamSegment[] = [];
    let retry: RetryProgress | undefined;
    let lastRetry: RetryProgress | undefined;
    let turnCheckpoint = streamCheckpoint(segments);
    let idCounter = 0;
    const nextId = () => `s-${++idCounter}`;

    streamSegmentsRef.current = segments;
    modelShotOpenRef.current = false;
    if (steerSplitRef.current) publishSteerSplit({ prefix: 0, holdOpen: false });
    const sync = () => {
      if (!liveTurnOnScreen(streamGeneration)) return;
      streamSegmentsRef.current = segments;
      if (steerSplitRef.current?.holdOpen) {
        steerSplitRef.current = { prefix: segments.length, holdOpen: true };
      }
      setStreamOverlay({ segments: [...segments], retry });
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
        if (!liveTurnOnScreen(streamGeneration)) return;
        if (event === 'ready') {
          opts?.onReady?.();
        }
        if (event === 'error') {
          const raw = typeof p.message === 'string' && p.message.trim() ? p.message.trim() : 'stream error';
          const failure = lastRetry?.phase === 'failed' ? lastRetry : undefined;
          const message = failure?.reason === 'exhausted'
            ? t('play.retry.exhausted', { requests: failure.requests, reason: failure.message })
            : failure?.reason === 'wait_limit'
              ? t('play.retry.waitLimit', { requests: failure.requests, reason: failure.message })
              : lastRetry?.phase === 'cancelled' ? t('play.retry.stopped')
              : t('play.status.runFailed', { error: modelErrorText(raw, t) });
          throw new PlayStreamError(message);
        }
        if (event === 'model' && p.type === 'model_retry') {
          const progress = readRetryProgress(p);
          if (progress) {
            lastRetry = progress;
            retry = ['waiting', 'requesting', 'switching'].includes(progress.phase) ? progress : undefined;
            sync();
          }
        }
        if (event === 'model' && p.type === 'done') {
          retry = undefined;
          lastRetry = undefined;
          sync();
          turnCheckpoint = streamCheckpoint(segments);
          modelShotOpenRef.current = false;
          const split = steerSplitRef.current;
          if (split?.holdOpen) publishSteerSplit({ prefix: segments.length, holdOpen: false });
        }
        if (event === 'model' && (p.type === 'text_delta' || p.type === 'reasoning_delta' || p.type === 'tool_call_start')) {
          modelShotOpenRef.current = true;
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
        if (isSessionResult(event, p)) {
          const sid = p.session.id;
          assertSessionClaim(streamGeneration, sid);
          liveOwnerRef.current = sid;
          onSession?.(sid);
          selectedSessionRef.current = sid;
          setSelectedSessionId(sid);
        }
      });
    }
  };

  /**
   * Listen for the run that an ask_user approve/reject is about to start.
   * `ready` resolves once the server is subscribed, before that run begins.
   */
  const reportFollowError = (error: unknown, controller: AbortController, generation: number) => {
    if (controller.signal.aborted || !liveTurnOnScreen(generation)) return;
    if (error instanceof Error && error.name === 'AbortError') return;
    setPlayStatus({ text: String(error), err: true });
  };

  const finishFollow = async (controller: AbortController, generation: number, claimedHere: boolean) => {
    if (liveFollowRef.current?.controller !== controller) return;
    liveFollowRef.current = null;
    if (!liveTurnCurrent(generation)) return;
    clearStreamingShell();
    if (claimedHere) liveOwnerRef.current = null;
    if (!controller.signal.aborted) {
      await tick({ includePlayPanel: true });
      const sid = selectedSessionRef.current;
      if (playSurface === 'bot' && sid) void requestInputSuggestionRef.current(sid);
    }
  };

  const armLiveSessionStream = (sessionId: string): LiveStreamArm => {
    const current = liveFollowRef.current;
    if (!canFollowSession(selectedSessionRef.current, sessionId)) return { ready: Promise.resolve(), cancel: () => undefined };
    if (activeFollowMatches(current, sessionId)) {
      return {
        ready: current!.ready,
        cancel: () => current!.controller.abort()
      };
    }
    current?.controller.abort();
    const controller = new AbortController();
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      const finish = () => resolve();
      resolveReady = finish;
      setTimeout(finish, 4000);
    });
    const follow = { sessionId, controller, ready };
    liveFollowRef.current = follow;
    const alreadyOwner = liveOwnerRef.current === sessionId;
    const generation = generationForArm(alreadyOwner, liveGenRef.current, () => claimLiveTurn(sessionId));
    setStreamOverlay({ segments: [] });
    const { url, body } = liveSessionFollowRequest(sessionId);
    void (async () => {
      try {
        await readSseFetch(url, body, undefined, {
          signal: controller.signal,
          extraAttempts: 0,
          onReady: () => resolveReady(),
          liveGen: generation
        });
      } catch (error) {
        reportFollowError(error, controller, generation);
      } finally {
        resolveReady();
        await finishFollow(controller, generation, !alreadyOwner);
      }
    })();
    return { ready, cancel: () => controller.abort() };
  };

  const armLiveSessionStreamRef = useRef(armLiveSessionStream);
  armLiveSessionStreamRef.current = armLiveSessionStream;

  useEffect(() => {
    const sid = selectedSessionId;
    if (!sid || chromeSessionId !== sid) return;
    if (!shouldResumeRunningTurn({ status: sessionChrome?.status, locallySending: playSendingLiveRef.current })) {
      return;
    }
    const armed = armLiveSessionStreamRef.current(sid);
    return () => {
      // Stop watching only. Closing this follow socket does not cancel the server run.
      armed.cancel();
    };
  }, [selectedSessionId, chromeSessionId, sessionChrome?.status]);

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
        agentId: resolveComposerAgentId(agentId, agents),
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

  const sendBotCommand = async (commandBotId: string, text: string) => {
      noteBotFirstTaskSent();
      stopSpeechDictation();
      const generation = claimLiveTurn(liveTurnOwnerId(selectedSessionRef.current));
      setPlaySending(true);
      try {
        let sid = selectedSessionRef.current;
        if (!sid) {
          sid = (await openBotSession(commandBotId, { liveGen: generation })).sessionId;
          assertLiveTurn(generation);
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
        assertLiveTurn(generation);
        acknowledgeLocalSendCommitted();
        clearComposerOnly();
        clearStreamingShell();
        const status = botComposerStatusText(t, data.command);
        setPlayStatus({ text: status.text, ok: !status.err, err: status.err });
        sessionListStickTopRef.current = true;
        await tick({ includePlayPanel: true });
      } catch (err) {
        if (!liveTurnOnScreen(generation)) return;
        setPlayStatus({ text: String(err), err: true });
      } finally {
        finishLiveTurn(generation);
      }
  };

  const sendPlayMessage = async () => {
    const text = goalMessage(playInput.trim(), playSurface === 'bot' ? selectedGoalId : null);
    const quoteSnapshot = replyQuoteRef.current;
    const replyFields = withReplyTo({}, quoteSnapshot);
    const sentText = text || '(attachment)';
    const consumeQuote = (visible: boolean) => {
      if (!quoteSnapshot) return;
      rememberPendingReply(
        replyMemoryRef.current,
        sentText,
        quoteSnapshot,
        historyMessagesRef.current.map((message) => messageId(message)).filter(Boolean)
      );
      if (visible) setOptimisticReply(quoteSnapshot);
      setReplyQuote(null);
    };
    const imageAssetIds = [...pendingImageAssetIds];
    const attachmentIds = [...pendingAttachmentIds];
    const contextSnapshot = pendingContext;
    const contextSources = contextSourcesForSend(pendingContext);
    const contextFields = contextSourcesBody(contextSources);
    const contextLabels = contextLabelsOf(contextSources);
    const hasAttachments = composerHasAttachments(imageAssetIds, attachmentIds, contextSources);
    const submission = contextSubmission(text, contextSources);
    const commandBotId = playSurface === 'bot' ? botIdRef.current : '';
    if (
      planBotComposerSend({
        botSelected: Boolean(commandBotId),
        text,
        hasAttachments
      }) === 'command'
    ) {
      await sendBotCommand(commandBotId, text);
      return;
    }
    if (workspaceAvailability.blocked) {
      setPlayStatus({
        text: workspaceAvailability.reason || t('play.composer.workspaceBlocked'),
        err: true
      });
      return;
    }
    const running = liveTurnRunning(liveOwnerRef.current, selectedSessionRef.current, playSending, Boolean(streamOverlay), waitTyping);
    if (running) {
      if (!submission.hasContent || !selectedSessionId) return;
      const steerSessionId = selectedSessionId;
      const steerGeneration = liveGenRef.current;
      const delivery = planRunningTurnDelivery({
        canonicalBotChat: composerIsCanonicalBot(),
        interruptPolicy: steerInterruptPolicy
      });
      const immediate = delivery.optimistic;
      if (delivery.blocked) {
        setPlayStatus({ text: t('play.status.steerDisabled'), err: true });
        return;
      }
      stopSpeechDictation();
      consumeQuote(immediate);
      if (immediate) {
        pendingSteerKnownIdsRef.current = new Set(
          historyMessagesRef.current.map((message) => messageId(message)).filter(Boolean)
        );
        pendingSteerTextRef.current = text;
        pendingSteerSessionRef.current = steerSessionId;
        anchorSteerSplit();
        acknowledgeLocalSendCommitted();
        requestScrollPlayToBottom();
        setOptimisticUser(userPreviewText(text, []));
        setOptimisticContext(contextLabels);
        clearComposerOnly();
      }
      try {
        const target = delivery.target;
        const execMode = queryExecModeRef.current;
        const data = (await api(`/api/sessions/${selectedSessionId}/steer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            immediate
              ? { text: submission.message, target, ...contextFields, ...replyFields }
              : { text: submission.message, target, ...steerBodyFromQueryMode(execMode), ...contextFields, ...replyFields }
          ),
        })) as { ok?: boolean; status?: string; reason?: string; item?: SteerInboxItem };
        if (!steerResponseApplies(steerGeneration, liveGenRef.current, steerSessionId, selectedSessionRef.current)) return;
        acknowledgeLocalSendCommitted();
        clearComposerOnly();
        if (delivery.revealSettings && execMode !== 'subagent' && data.item?.id) {
          setSteerInbox((prev) => [
            ...prev,
            { id: data.item!.id, text: data.item!.text || text, target, mode: 'steering' }
          ]);
        }
        if (data.status === 'rejected' || data.status === 'not_submitted') {
          forgetPendingReply(replyMemoryRef.current);
          if (!immediate) setReplyQuote(quoteSnapshot);
          if (immediate) {
            const rejected = steerUiAfterSend({ rejected: true, text, optimistic: pendingSteerTextRef.current });
            pendingSteerTextRef.current = null;
            pendingSteerSessionRef.current = null;
            clearSteerSplit();
            setOptimisticUser(rejected.bubble);
            setOptimisticContext([]);
            setOptimisticReply(null);
            setPlayInput(rejected.composer ?? text);
            setPendingContext(contextSnapshot);
            setReplyQuote(quoteSnapshot);
          }
          const why =
            data.reason === 'session_ended'
              ? t('play.status.sessionEnded')
              : data.reason === 'no_session'
                ? t('play.status.noSession')
                : data.reason === 'steer_disabled'
                  ? t('play.status.steerDisabled')
                  : data.reason || t('play.status.notAccepted');
          setPlayStatus({ text: t('play.status.notAcceptedWhy', { why }), err: true });
        } else if (!immediate && execMode === 'subagent') {
          setPlayStatus({ text: t('play.status.queuedSubagent'), ok: true });
        } else if (!immediate && data.status === 'queued') {
          setPlayStatus({
            text: steerInterruptPolicy === 'queue' ? t('play.status.queuedEnd') : t('play.status.queuedNext'),
            ok: true
          });
        } else {
          setPlayStatus({ text: t('play.status.steered'), ok: true });
        }
      } catch (err) {
        if (!steerResponseApplies(steerGeneration, liveGenRef.current, steerSessionId, selectedSessionRef.current)) return;
        if (!immediate) setReplyQuote(quoteSnapshot);
        if (immediate) {
          const rejected = steerUiAfterSend({ rejected: true, text, optimistic: pendingSteerTextRef.current });
          pendingSteerTextRef.current = null;
          pendingSteerSessionRef.current = null;
          clearSteerSplit();
          setOptimisticUser(rejected.bubble);
          setOptimisticContext([]);
          setOptimisticReply(null);
          setPlayInput(rejected.composer ?? text);
          setPendingContext(contextSnapshot);
          setReplyQuote(quoteSnapshot);
        }
        forgetPendingReply(replyMemoryRef.current);
        setPlayStatus({ text: err instanceof Error ? err.message : String(err), err: true });
      }
      return;
    }
    stopSpeechDictation();
    if (!text && !hasAttachments) return;
    const draftSnapshot = playInput;
    const imageSnapshot = [...pendingImageAssetIds];
    const attachmentSnapshot = [...pendingAttachmentIds];
    setPlayStatus({ text: '' });
    const generation = claimLiveTurn(liveTurnOwnerId(selectedSessionId));
    setPlaySending(true);

    const preview = userPreviewText(text || '(image)', imageAssetIds);
    const beginStreamTurn = () => {
      if (playSurface === 'bot') noteBotFirstTaskSent();
      acknowledgeLocalSendCommitted();
      requestScrollPlayToBottom();
      setOptimisticUser(preview);
      setOptimisticContext(contextLabels);
      consumeQuote(true);
      setStreamOverlay({ segments: [] });
      clearComposerOnly();
    };
    const beginWaitTurn = () => {
      if (playSurface === 'bot') noteBotFirstTaskSent();
      acknowledgeLocalSendCommitted();
      requestScrollPlayToBottom();
      setOptimisticUser(preview);
      setOptimisticContext(contextLabels);
      consumeQuote(true);
      setWaitTyping(true);
      clearComposerOnly();
    };

    try {
      const activeBotId = playSurface === 'bot' ? botIdRef.current : '';
      const hadSession = Boolean(selectedSessionRef.current);
      let sid = selectedSessionId;
      if (!sid && activeBotId) {
        const opened = await openBotSession(activeBotId, { liveGen: generation });
        sid = opened.sessionId;
      }
      assertLiveTurn(generation);
      if (sid) {
        if (useStream) {
          beginStreamTurn();
          await readSseFetch(
            `/api/sessions/${sid}/stream`,
            {
              message: text || '(attachment)',
              imageAssetIds,
              attachmentIds,
              ...contextFields,
              ...replyFields,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            },
            undefined,
            { liveGen: generation }
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
              ...contextFields,
              ...replyFields,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            }),
          });
        }
        assertLiveTurn(generation);
        finishLiveTurn(generation);
        setPlayStatus({ text: t('play.status.sent'), ok: true });
        if (playSurface === 'bot') void requestInputSuggestion(sid);
      } else if (activeBotId) {
        throw new Error(t('play.status.openBotFailed'));
      } else if (mode === 'chat') {
        if (useStream) {
          beginStreamTurn();
          await readSseFetch('/api/chat/stream', {
            message: text || '(attachment)',
            title: (text || t('play.attachment')).slice(0, 60),
            agentId: resolveComposerAgentId(agentId, agents),
            imageAssetIds,
            attachmentIds,
            ...contextFields,
            ...replyFields,
            ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
            ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
            ...modelRefBody(modelRefForSend),
            ...workspaceBindingBody(workspaceBinding),
          }, undefined, { liveGen: generation });
          assertLiveTurn(generation);
          finishLiveTurn(generation);
          setPlayStatus({ text: t('play.status.streamDone'), ok: true });
        } else {
          beginWaitTurn();
          const data = (await api('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text || '(attachment)',
              title: (text || t('play.attachment')).slice(0, 60),
              agentId: resolveComposerAgentId(agentId, agents),
              imageAssetIds,
              attachmentIds,
              ...contextFields,
              ...replyFields,
              ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
              ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
              ...modelRefBody(modelRefForSend),
              ...workspaceBindingBody(workspaceBinding),
            }),
          })) as { session: { id: string } };
          const newSid = data.session.id;
          assertSessionClaim(generation, newSid);
          liveOwnerRef.current = newSid;
          selectedSessionRef.current = newSid;
          setSelectedSessionId(newSid);
          finishLiveTurn(generation);
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
            ...contextFields,
            ...replyFields,
            agentId: resolveComposerAgentId(agentId, agents),
            autoRun: true,
            background: true,
            ...optionalGroupsBody(optionalToolGroupsFeature, enabledOptionalGroupIds),
            ...orchestrationBody(taskMode, orchestrationEngine, skillScope),
            ...modelRefBody(modelRefForSend),
            ...workspaceBindingBody(workspaceBinding),
          }),
        })) as { session: { id: string } };
        const newSid = data.session.id;
        assertSessionClaim(generation, newSid);
        liveOwnerRef.current = newSid;
        selectedSessionRef.current = newSid;
        setSelectedSessionId(newSid);
        finishLiveTurn(generation);
        await refreshPlayPanel();
        setPlayStatus({ text: t('play.status.taskCreated'), ok: true });
      }
      assertLiveTurn(generation);
      if (!hadSession && !activeBotId && selectedSessionRef.current) {
        await persistPendingStrategy(selectedSessionRef.current);
      }
      sessionListStickTopRef.current = true;
      await tick({ includePlayPanel: true });
    } catch (e) {
      await runIf(ownsLiveTurn(e, liveTurnOnScreen(generation)), async () => {
        setPlayStatus({ text: modelErrorText(e instanceof Error ? e.message : String(e), t), err: true });
        const persisted = e instanceof PlayStreamError && e.persisted;
        restoreComposerUnlessPersisted(persisted, () => {
          setPlayInput(draftSnapshot);
          setPendingImageAssetIds(imageSnapshot);
          setPendingAttachmentIds(attachmentSnapshot);
          setPendingContext(contextSnapshot);
          forgetPendingReply(replyMemoryRef.current);
          setOptimisticReply(null);
          setReplyQuote(quoteSnapshot);
        });
        finishLiveTurn(generation);
        await tickIfPersisted(persisted, () => tick({ includePlayPanel: true }));
      });
    } finally {
      releaseIfCurrent(liveTurnCurrent(generation), () => setPlaySending(false));
    }
  };

  const handleFileUpload = async (files: FileList) => {
    const selectedFiles = Array.from(files);
    try {
      const sid = await ensurePlaySessionForImages();
      const imgIds = [...pendingImageAssetIds];
      const attIds = [...pendingAttachmentIds];
      for (const file of selectedFiles) {
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
      setPlayStatus({ text: t('play.status.addedFiles', { count: selectedFiles.length }), ok: true });
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

  const pendingSteerText = pendingSteerTextRef.current;
  const steerLanded = Boolean(
    pendingSteerText &&
      sessionMessages.some((message) => {
        const id = messageId(message);
        return message.role === 'user' && Boolean(id) && !pendingSteerKnownIdsRef.current.has(id) && messageUserText(message).includes(pendingSteerText);
      })
  );
  const screen = screenLiveTurn({
    selectedSessionId,
    loadedSessionId: historySessionRef.current,
    messages: sessionMessages,
    liveSessionId: liveOwnerRef.current,
    optimisticUser,
    pendingSteerSessionId: pendingSteerSessionRef.current,
    steerLanded,
    hasStream: streamOverlay != null,
    waitTyping,
    playSending,
  });

  return {
    stopLiveTurn: () => {
      liveGenRef.current += 1;
      liveOwnerRef.current = null;
      clearStreamingShell();
      setPlaySending(false);
      setPlayStatus({ text: t('play.retry.stopped') });
    },
    historyCursor,historyLoading,loadOlderHistory,
    transcriptReady: screen.bound,
    loadedTranscriptSessionId: historySessionRef.current,
    // State
    sessionMessages: screen.messages,
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
    selectedGoalId,
    setSelectedGoalId,
    playInput,
    setPlayInput,
    inputGhost,
    ghostSuggestion: ghostText(inputGhost),
    acceptInputSuggestion,
    dismissInputSuggestion,
    noteComposerTyped: () => {
      if (ghostText(inputGhostRef.current)) setInputGhost(emptyGhost());
    },
    noteComposerBlur: () => {
      if (ghostText(inputGhostRef.current)) setInputGhost(emptyGhost());
    },
    imageUrlInput,
    setImageUrlInput,
    pendingImageAssetIds,
    setPendingImageAssetIds,
    pendingAttachmentIds,
    setPendingAttachmentIds,
    pendingContext,
    addPendingContext,
    removePendingContext,
    optimisticContext,
    sessionFileArtifacts,
    playStatus,
    setPlayStatus,
    optimisticUser: screen.optimisticUser,
    steerStreamPrefix: steerPrefixCount({
      show: Boolean(screen.optimisticUser),
      split: steerSplit,
      segmentCount: streamOverlay?.segments.length ?? 0
    }),
    optimisticReply: screen.optimisticUser ? optimisticReply : null,
    replyQuote,
    quoteReply,
    cancelReplyQuote,
    streamOverlay: visibleStream(screen.hasStream, streamOverlay),
    waitTyping: screen.waitTyping,
    playSending: screen.playSending,
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
    getBotSelectionVersion: () => botOpenRequestRef.current,
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
    setShowModelView:toggleModelView,
    modelViewPayload,
    showJumpToLatest,
    displayMessages:
      transcriptModelView(screen.bound, showModelView, modelViewPayload?.modelView, screen.messages),
    optionalToolGroupsFeature,
    optionalToolCatalog,
    enabledOptionalGroupIds,
    toggleOptionalGroup,
    steerInterruptPolicy,
    immediateSteer,
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
    playStickToBottomRef,
    feedScrollIntentRef,
    feedRevision,
    // Methods
    handlePlayMessagesScroll,
    refreshPlayPanel,
    requestScrollPlayToBottom,
    sendPlayMessage,
    armLiveSessionStream,
    handleFileUpload,
    handleUrlFetch,
    setPlayTitle,
    setPlayMeta,
    setSessionMessages,
  };
}

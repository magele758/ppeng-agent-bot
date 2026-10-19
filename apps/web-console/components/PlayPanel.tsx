'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { AgentInfo, ApprovalItem, BotInfo, SessionSummary } from '@/lib/types';
import { botForCanonicalSession, visibleBotRoster, type PlaySurface } from '@/lib/bots';
import { collectActivityTools, collectArtifacts } from '@/lib/activity-tools';
import {
  formatCostUsd,
  latestGoalMet,
  type AutonomyLevel,
  type SessionRunOutcome
} from '@/lib/session-chrome';
import {
  buildTurnFeedStats,
  formatTurnFeedStatsLine,
  type TurnFeedTraceEvent
} from '@/lib/turn-feed-stats';
import { api } from '@/lib/api';
import { nextMenuIndex } from '@/lib/entry-navigation';
import { formatHash } from '@/lib/nav';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { PlayTranscript } from './PlayTranscript';
import type { usePlayChat } from './usePlayChat';
import { ActivityPanel } from './ActivityPanel';
import { ArtifactRail } from './ArtifactRail';
import { BotCronPanel } from './BotCronPanel';
import { composerModelLocked } from '@/lib/bot-model';
import { COMPOSITION_ENTER_GUARD_MS, IME_COMPOSITION_KEY_CODE, decideComposerEnter } from '@/lib/composer-enter';
import { ApprovalBanner } from './ApprovalBanner';
import { GoalStatusCard } from './GoalStatusCard';
import { TrajectoryPanel } from './TrajectoryPanel';
import { ContextStackPanel } from './ContextStackPanel';
import { groupAgentsByDomain, sortAgentsById } from '@/lib/sort-utils';
import { groupSessionsByDate } from '@/lib/session-groups';
import { WorkspacePicker } from './WorkspacePicker';
import { catalogToPickerOptions } from '@/lib/model-providers';
import { useBotWorkMood } from './bot-work/BotWorkState';
import { botChatHeaderTitle, botNameFromCanonicalTitle } from '@/lib/bot-chat-header';
import { BotFace } from './BotFace';
import { resolveLivingFaceMood } from '@/lib/bot-face';
import { ComposerBotPicker } from './ComposerBotPicker';
import { shouldOpenSessionSettingsOnInboxGrowth } from '@/lib/running-turn-send';
import { ComposerContextChips, useComposerFileDrop } from './ComposerContext';
import { composerClassName, composerSendDisabled } from '@/lib/composer-context';
import { ComposerModelPicker } from './ComposerModelPicker';
import { SessionSettingsPanel, type ExecPreset } from './sections/chat/SessionSettingsPanel';
import { PlayBotGroupChat } from './play-group/PlayBotGroupChat';
import { PlayBotGroupList } from './play-group/PlayBotGroupList';
import { SessionListRow } from './SessionListRow';
import { BotFunctionalGroups } from './BotFunctionalGroups';
import { BotPinArea } from './BotPinArea';
import { BotPermissionsLink, BotDetailPane, BotDetailToggle, botDetailIsVisible, botDetailMainClass } from './BotDetailMenu';
import { useBotSessionQuestions } from './useBotSessionQuestions';
import { BotEntryDialog } from './BotEntryDialog';
import { BotCreateForm } from './sections/agents/BotCreateForm';
import { BotGroupCreateForm } from './sections/agents/BotGroupCreateForm';
import { useLab } from './shell/LabProvider';

function isCoreExecAgent(id: string): boolean {
  return id === 'general' || id === 'main';
}

function execPresetOf(agentId: string, mode: 'chat' | 'task'): ExecPreset {
  if (agentId === 'main') return 'orchestrator';
  return mode === 'task' ? 'task' : 'chat';
}

function supportAgentsOf(aList: AgentInfo[]): AgentInfo[] {
  return aList.filter((a) => !isCoreExecAgent(a.id));
}

export interface PlayPanelProps {
  active: boolean;
  sessions: SessionSummary[];
  agents: AgentInfo[];
  bots: BotInfo[];
  playSurface: PlaySurface;
  onPlaySurfaceChange: (surface: PlaySurface) => void;
  approvals: ApprovalItem[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDeleteSessions?: (ids: string[]) => Promise<void>;
  onNewSession: () => void;
  onRunSession: () => void;
  onCancelSession: () => void;
  onOpenTrace: () => void;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
  chat: ReturnType<typeof usePlayChat>;
  sessionFilter?: string;
  onSessionFilterChange?: (value: string) => void;
  onOpenModelSetup: () => void;
  accountMenu?: ReactNode;
}

function statusDotClass(status: string): string {
  if (status === 'running') return 'status-dot status-dot--run';
  if (status === 'waiting_approval') return 'status-dot status-dot--warn';
  if (status === 'completed') return 'status-dot status-dot--ok';
  if (status === 'failed') return 'status-dot status-dot--err';
  return 'status-dot';
}

const STOP_REASON_DETAIL: Record<string, MessageKey> = {
  end: 'play.stopReason.end',
  abort: 'play.stopReason.abort',
  user_abort: 'play.stopReason.user_abort',
  closed: 'play.stopReason.closed',
  waiting_approval: 'play.stopReason.waiting_approval',
  empty_assistant: 'play.stopReason.empty_assistant',
  empty_tool_calls: 'play.stopReason.empty_tool_calls',
  leaked_tool_call: 'play.stopReason.leaked_tool_call',
  truncated_tool_call: 'play.stopReason.truncated_tool_call',
  content_filter: 'play.stopReason.content_filter',
  repetition: 'play.stopReason.repetition',
  reasoning_spin: 'play.stopReason.reasoning_spin',
  loop_guard_critical: 'play.stopReason.loop_guard_critical',
  tool_loop: 'play.stopReason.tool_loop',
  missing_assistant: 'play.stopReason.missing_assistant',
  before_turn_blocked: 'play.stopReason.before_turn_blocked',
  rewound: 'play.stopReason.rewound'
};

function stopReasonKindKey(kind: SessionRunOutcome['kind']): MessageKey {
  switch (kind) {
    case 'idle':
      return 'play.stopReason.kindIdle';
    case 'completed':
      return 'play.stopReason.kindCompleted';
    case 'failed':
      return 'play.stopReason.kindFailed';
    case 'aborted':
      return 'play.stopReason.kindAborted';
    case 'waiting_approval':
      return 'play.stopReason.kindWaiting';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function sessionStatusKey(status: string): MessageKey | null {
  switch (status) {
    case 'running':
      return 'play.sessionStatus.running';
    case 'waiting_approval':
      return 'play.sessionStatus.waitingApproval';
    case 'failed':
      return 'play.sessionStatus.failed';
    case 'unknown':
      return 'play.sessionStatus.unknown';
    default:
      return null;
  }
}

function sessionStatusLabelKey(status: string): MessageKey | null {
  switch (status) {
    case 'idle':
      return 'play.sessionStatus.idle';
    case 'completed':
      return 'play.sessionStatus.completed';
    default:
      return sessionStatusKey(status);
  }
}

function ChatStopReasonFooter({ outcome }: { outcome?: SessionRunOutcome }) {
  const { t } = useI18n();
  if (!outcome) return null;
  const detailKey = STOP_REASON_DETAIL[outcome.reason];
  const detail = detailKey
    ? t(detailKey)
    : t('play.stopReason.other', { reason: outcome.reason });
  const kind =
    outcome.kind === 'idle' || outcome.kind === 'completed' ? '' : `${t(stopReasonKindKey(outcome.kind))} · `;
  return (
    <footer
      className={`chat-stop-reason chat-stop-reason--${outcome.kind}`}
      aria-label={t('play.stopReason.aria')}
    >
      {t('play.stopReason.label')}：{kind}
      {detail}
    </footer>
  );
}

function ChatFeedStatsFooter({ line, turnIndex }: { line: string | null; turnIndex?: number }) {
  const { t } = useI18n();
  if (!line) return null;
  return (
    <footer
      className="chat-feed-stats chat-feed-stats--turn"
      aria-label={t('play.chrome.feedStatsAria')}
      data-turn-index={turnIndex != null ? String(turnIndex) : undefined}
    >
      {line}
    </footer>
  );
}

function autonomyKey(level: AutonomyLevel): MessageKey {
  switch (level) {
    case 'supervised':
      return 'play.autonomy.supervised';
    case 'autonomous':
      return 'play.autonomy.autonomous';
    case 'balanced':
      return 'play.autonomy.balanced';
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

function sessionGroupDisplay(
  bucket: string,
  fallback: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  switch (bucket) {
    case 'today':
      return t('play.sessionGroup.today');
    case 'yesterday':
      return t('play.sessionGroup.yesterday');
    case 'week':
      return t('play.sessionGroup.week');
    case 'month':
      return t('play.sessionGroup.month');
    case 'older':
      return t('play.sessionGroup.older');
    default:
      if (bucket.startsWith('m:')) {
        const [year, month] = bucket.slice(2).split('-');
        return t('play.sessionGroup.yearMonth', { year: year ?? '', month: String(Number(month)) });
      }
      return fallback;
  }
}

export function PlayPanel({
  active,
  sessions,
  agents,
  bots,
  playSurface,
  onPlaySurfaceChange,
  approvals,
  selectedSessionId,
  onSelectSession,
  onDeleteSessions,
  onNewSession,
  onRunSession,
  onCancelSession,
  onOpenTrace,
  onApprovalsChanged,
  onAttachStream,
  chat,
  sessionFilter = '',
  onSessionFilterChange,
  onOpenModelSetup,
  accountMenu
}: PlayPanelProps) {
  const { t } = useI18n();
  const contextDrop = useComposerFileDrop((sources, truncated) => {
    chat.addPendingContext(sources);
    if (truncated) chat.setPlayStatus({ text: t('play.composer.contextTruncated') });
  }, `${playSurface}:${chat.botId}:${selectedSessionId}`);
  const [attachOpen, setAttachOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createKind, setCreateKind] = useState<'bot' | 'room' | null>(null);
  const [functionalCreate, setFunctionalCreate] = useState(0);
  const [botRemoveError, setBotRemoveError] = useState('');
  const { upsertBot, setBots, tick } = useLab();
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [groupCount, setGroupCount] = useState(0);
  const botQuestions = useBotSessionQuestions({
    sessions,
    bots,
    selectedSessionId,
    selectedMessages: chat.sessionMessages,
    pendingQuestion: chat.optimisticUser
  });
  const createMenuRef = useRef<HTMLDivElement>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const prevSteerCountRef = useRef(0);
  const [railTab, setRailTab] = useState<'activity' | 'context' | 'artifacts' | 'cron' | 'trajectory'>('activity');
  const [botDetailOpen, setBotDetailOpen] = useState(false);
  const flatAgents = sortAgentsById(agents);
  const supportAgents = useMemo(() => supportAgentsOf(flatAgents), [flatAgents]);
  const supportByDomain = useMemo(() => groupAgentsByDomain(supportAgents), [supportAgents]);
  const execPreset = execPresetOf(chat.agentId, chat.mode);
  const agentSelectValue = isCoreExecAgent(chat.agentId) || !chat.agentId ? '' : chat.agentId;
  const chatRunning = chat.playSending || Boolean(chat.streamOverlay) || chat.waitTyping;
  const immediateSteer = chat.immediateSteer;
  const steerDisabled = chatRunning && !immediateSteer && chat.steerInterruptPolicy === 'disabled';
  const runningPlaceholder = immediateSteer
    ? t('play.composer.runningSteer')
    : chat.steerInterruptPolicy === 'disabled'
      ? t('play.composer.runningDisabled')
      : chat.steerInterruptPolicy === 'queue'
        ? t('play.composer.runningQueue')
        : t('play.composer.runningSteer');

  const compositionActiveRef = useRef(false);
  const compositionJustEndedRef = useRef(false);
  const compositionGuardTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (compositionGuardTimerRef.current != null) {
        window.clearTimeout(compositionGuardTimerRef.current);
      }
    };
  }, []);

  const clearCompositionGuard = () => {
    if (compositionGuardTimerRef.current != null) {
      window.clearTimeout(compositionGuardTimerRef.current);
      compositionGuardTimerRef.current = null;
    }
  };

  const onComposerCompositionStart = () => {
    compositionActiveRef.current = true;
    compositionJustEndedRef.current = false;
    clearCompositionGuard();
  };

  const onComposerCompositionEnd = () => {
    compositionActiveRef.current = false;
    compositionJustEndedRef.current = true;
    clearCompositionGuard();
    compositionGuardTimerRef.current = window.setTimeout(() => {
      compositionJustEndedRef.current = false;
      compositionGuardTimerRef.current = null;
    }, COMPOSITION_ENTER_GUARD_MS);
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    const decision = decideComposerEnter({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: native.isComposing,
      keyCode:
        event.keyCode === IME_COMPOSITION_KEY_CODE || native.keyCode === IME_COMPOSITION_KEY_CODE
          ? IME_COMPOSITION_KEY_CODE
          : native.keyCode,
      compositionActive: compositionActiveRef.current,
      compositionJustEnded: compositionJustEndedRef.current,
    });
    if (decision.preventDefault) event.preventDefault();
    if (decision.send) void chat.sendPlayMessage();
  };

  const applyExecPreset = (preset: ExecPreset) => {
    const support = agentSelectValue;
    if (preset === 'orchestrator') {
      void chat.setExecutionMode('main', 'chat');
      return;
    }
    void chat.setExecutionMode(support || 'general', preset);
  };

  const applySupportAgent = (next: string) => {
    if (!next) {
      void chat.setExecutionMode(execPreset === 'orchestrator' ? 'main' : 'general', execPreset === 'task' ? 'task' : 'chat');
      return;
    }
    void chat.setExecutionMode(next, execPreset === 'task' ? 'task' : 'chat');
  };

  const renderAgentOptions = (includeCurrent: boolean) => (
    <>
      <option value="">{t('play.assembly.followExec')}</option>
      {includeCurrent && chat.agentId && !isCoreExecAgent(chat.agentId) && !supportAgents.some((a) => a.id === chat.agentId) ? (
        <option value={chat.agentId}>{chat.agentId}</option>
      ) : null}
      {supportByDomain.length <= 1
        ? supportAgents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name && a.name !== a.id ? a.name : a.id}
              {a.role ? ` · ${a.role}` : ''}
            </option>
          ))
        : supportByDomain.map(({ domainId, agents: bucket }) => (
            <optgroup key={domainId} label={domainId.toUpperCase()}>
              {bucket.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name && a.name !== a.id ? a.name : a.id}
                  {a.role ? ` · ${a.role}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
    </>
  );
  const botRoster = useMemo(() => visibleBotRoster(bots), [bots]);
  const selectedBot = useMemo(
    () => botRoster.find((b) => b.id === chat.botId) ?? bots.find((b) => b.id === chat.botId) ?? null,
    [botRoster, bots, chat.botId]
  );
  const botLocked = playSurface === 'bot' && Boolean(chat.botId);
  const botSurface = playSurface === 'bot';
  const headerBotChat = botSurface && Boolean(selectedSessionId);
  const headerBotName = headerBotChat
    ? selectedBot?.name?.trim() || botNameFromCanonicalTitle(chat.playTitle)
    : '';
  const headerTitle = botChatHeaderTitle({
    botChat: headerBotChat,
    botName: headerBotName,
    sessionTitle: chat.playTitle
  });
  const headerBotId = headerBotChat ? chat.botId || selectedBot?.id || '' : '';
  const botDetailVisible = botDetailIsVisible(botDetailOpen, headerBotId, openGroupId);
  const headerWorkMood = useBotWorkMood(headerBotId);
  const pickerWorkMood = useBotWorkMood(chat.botId);
  const headerFaceMood = resolveLivingFaceMood({live:headerWorkMood!=='idle',segments:chat.streamOverlay?.segments});
  const pickerFaceMood = resolveLivingFaceMood({live:pickerWorkMood!=='idle',segments:chat.streamOverlay?.segments});

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId]
  );
  const sessionBusy =
    selectedSession?.status === 'running' ||
    selectedSession?.status === 'waiting_approval' ||
    chat.playSending ||
    Boolean(chat.streamOverlay) ||
    chat.waitTyping;

  const sessionApprovals = useMemo(
    () =>
      approvals.filter(
        (a) => a.sessionId === selectedSessionId && (!a.status || a.status === 'pending')
      ),
    [approvals, selectedSessionId]
  );

  const activityItems = useMemo(
    () => collectActivityTools(chat.sessionMessages, chat.streamOverlay?.segments),
    [chat.sessionMessages, chat.streamOverlay]
  );
  const sessionGroups = useMemo(() => groupSessionsByDate(sessions), [sessions]);
  const visibleIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const checkedVisible = useMemo(
    () => checkedIds.filter((id) => visibleIds.includes(id)),
    [checkedIds, visibleIds]
  );

  useEffect(() => {
    setCheckedIds((prev) => {
      const next = prev.filter((id) => visibleIds.includes(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  useEffect(() => {
    if (botSurface) return;
    setOpenGroupId(null);
    setGroupCount(0);
  }, [botSurface]);

  const toggleChecked = (id: string, on: boolean) => {
    setCheckedIds((prev) => {
      if (on) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setCheckedIds([]);
  };

  const confirmDelete = async (ids: string[], message: string) => {
    if (!onDeleteSessions || !ids.length || deleting) return;
    if (!window.confirm(message)) return;
    setDeleting(true);
    try {
      await onDeleteSessions(ids);
      setCheckedIds((prev) => prev.filter((id) => !ids.includes(id)));
      if (selectMode && ids.length >= checkedVisible.length) exitSelectMode();
    } finally {
      setDeleting(false);
    }
  };
  const enabledModelOptions = useMemo(
    () => catalogToPickerOptions(chat.modelCatalog),
    [chat.modelCatalog]
  );

  const artifacts = useMemo(
    () =>
      collectArtifacts(
        chat.sessionMessages,
        chat.streamOverlay?.segments,
        chat.pendingImageAssetIds,
        chat.sessionFileArtifacts
      ),
    [chat.sessionMessages, chat.streamOverlay, chat.pendingImageAssetIds, chat.sessionFileArtifacts]
  );

  const chrome = chat.sessionChrome;
  const headerStatus = chrome?.status ?? selectedSession?.status ?? '';
  const headerStatusKey = sessionStatusLabelKey(headerStatus);
  const headerStatusText = headerStatusKey ? t(headerStatusKey) : headerStatus;
  const goalMet = chrome ? latestGoalMet(chrome) : null;
  const tokens =
    chrome?.usageTotals?.totalTokens ??
    (chrome?.usageTotals
      ? (chrome.usageTotals.inputTokens ?? 0) + (chrome.usageTotals.outputTokens ?? 0)
      : undefined);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [feedTraces, setFeedTraces] = useState<TurnFeedTraceEvent[]>([]);
  const statsLive = chatRunning || chrome?.status === 'running' || selectedSession?.status === 'running';
  useEffect(() => {
    if (!statsLive) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [statsLive]);
  useEffect(() => {
    if (!selectedSessionId) {
      setFeedTraces([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const { events } = (await api(
          `/api/traces?sessionId=${encodeURIComponent(selectedSessionId)}&limit=500`
        )) as { events?: TurnFeedTraceEvent[] };
        if (!cancelled) setFeedTraces(events ?? []);
      } catch {
        if (!cancelled) setFeedTraces([]);
      }
    };
    void load();
    if (!statsLive) return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void load(), 2800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedSessionId, statsLive, chat.sessionMessages.length]);
  useEffect(() => {
    const n = chat.steerInbox.length;
    if (
      shouldOpenSessionSettingsOnInboxGrowth({
        previousCount: prevSteerCountRef.current,
        nextCount: n,
        immediateSteer
      })
    ) {
      setConfigOpen(true);
    }
    prevSteerCountRef.current = n;
  }, [chat.steerInbox.length, immediateSteer]);
  const feedHasTurns =
    chat.sessionMessages.length > 0 ||
    Boolean(chat.optimisticUser) ||
    Boolean(chat.streamOverlay) ||
    chat.waitTyping;
  const turnStatsLabels = useMemo(
    () => ({
      elapsed: t('play.stats.elapsed'),
      input: t('play.stats.input'),
      output: t('play.stats.output')
    }),
    [t]
  );
  const turnFeedStats = useMemo(() => {
    if (!selectedSessionId || !feedHasTurns) return [];
    return buildTurnFeedStats({
      messages: chat.sessionMessages as Array<{ role?: string; createdAt?: unknown }>,
      traces: feedTraces,
      running: statsLive,
      now: nowMs
    });
  }, [selectedSessionId, feedHasTurns, chat.sessionMessages, feedTraces, statsLive, nowMs]);
  const turnFeedStatLines = useMemo(
    () => turnFeedStats.map((stat) => formatTurnFeedStatsLine(stat, turnStatsLabels)),
    [turnFeedStats, turnStatsLabels]
  );

  useEffect(() => {
    if (!botSurface) {
      setRailTab((tab) => (tab === 'cron' ? 'activity' : tab));
    }
  }, [botSurface]);

  useEffect(() => {
    if (!createMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (createMenuRef.current?.contains(e.target as Node)) return;
      setCreateMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreateMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [createMenuOpen]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (moreMenuRef.current?.contains(e.target as Node)) return;
      setMoreMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!configOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (configBtnRef.current?.contains(target) || configPanelRef.current?.contains(target)) return;
      setConfigOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfigOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [configOpen]);

  const openCreateChat = () => {
    setCreateMenuOpen(false);
    if (playSurface !== 'chat') onPlaySurfaceChange('chat');
    onNewSession();
  };

  useLayoutEffect(() => {
    const el = chat.playInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [chat.playInput, chat.playInputRef]);


  const removeBot = async (rowBot: BotInfo) => {
    if (deleting || !window.confirm(t('play.entry.removeBotConfirm', { name: rowBot.name }))) return;
    setDeleting(true);
    setBotRemoveError('');
    try {
      await api(`/api/bots/${encodeURIComponent(rowBot.id)}`, { method: 'PATCH', body: JSON.stringify({ hidden: true }) });
      setBots(previous => previous.map(bot => bot.id === rowBot.id ? { ...bot, hidden: true } : bot));
    } catch (cause) {
      setBotRemoveError(t('play.entry.removeFailed', { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally { setDeleting(false); }
  };
  const removalProps = (s: SessionSummary, rowBot: BotInfo | undefined) => {
    if (rowBot) return { deleteAria: t('play.entry.removeBot', { name: rowBot.name }), deleteLabel: t('play.entry.remove'), onDelete: () => { void removeBot(rowBot); } };
    if (!onDeleteSessions) return {};
    return { onDelete: (title: string) => { void confirmDelete([s.id], t('play.sidebar.deleteConfirmOne', { title })); } };
  };
  const rowBotFor = (s: SessionSummary) => botSurface ? botForCanonicalSession(bots, s.id, sessions) : undefined;

  const renderSession = (s: SessionSummary) => {
    const rowBot = rowBotFor(s);
    if (rowBot?.hidden) return null;
    const checked = checkedVisible.includes(s.id);
    const statusKey = sessionStatusKey(s.status);
    return (
      <SessionListRow
        key={s.id}
        session={s}
        bots={bots}
        question={botQuestions.get(s.id) ?? ''}
        selected={!openGroupId && selectedSessionId === s.id}
        checked={checked}
        selectMode={selectMode}
        deleting={deleting}
        status={
          statusKey ? (
            <span className={`session-item__status session-item__status--${s.status}`}>
              <span className={statusDotClass(s.status)} aria-hidden="true" />
              {t(statusKey)}
            </span>
          ) : null
        }
        onOpen={() => {
          setOpenGroupId(null);
          onSelectSession(s.id);
        }}
        onToggleChecked={(next) => toggleChecked(s.id, next)}
        {...removalProps(s, rowBot)}
      />
    );
  };

  const renderCreateDialog = () => (
    createKind ? <BotEntryDialog label={createKind === 'bot' ? t('play.newBot') : t('play.group.create')}>
        {createKind === 'bot' ? <BotCreateForm existingNames={bots.map(bot => bot.name)} onCreated={bot => { upsertBot(bot); setCreateKind(null); void tick({ includePlayPanel: false }); }} onCancel={() => setCreateKind(null)} /> : <BotGroupCreateForm bots={botRoster} onCreated={() => setCreateKind(null)} onCancel={() => setCreateKind(null)} />}
      </BotEntryDialog> : null
  );

  return (
    <section className={`panel ${active ? 'active' : ''}`} id="panel-play">
      {renderCreateDialog()}
      <div className="play-layout play-layout--rail">
        <aside className="play-sidebar">
          <div className="play-sidebar__head">
            <div className="create-menu" ref={createMenuRef} onMouseEnter={() => setCreateMenuOpen(true)} onMouseLeave={() => setCreateMenuOpen(false)} onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); setCreateMenuOpen(true);
              requestAnimationFrame(() => {
                const items = Array.from(createMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
                const next = nextMenuIndex(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
                items[next]?.focus();
              });
            }}>
              <button
                type="button"
                id="btnPlayCreate"
                className={`btn btn-primary btn-sm${createMenuOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-controls="playCreateMenu"
                onClick={() => setCreateMenuOpen(true)}
              >
                {botSurface ? t('play.entry.new') : t('play.add')}
              </button>
              {createMenuOpen ? (
                <div className="create-menu__pop" id="playCreateMenu" role="menu">
                  {!botSurface ? <button type="button" role="menuitem" className="create-menu__item" onClick={openCreateChat}>{t('play.newSession')}</button> : null}
                  <button type="button" role="menuitem" className="create-menu__item" onClick={() => { setCreateMenuOpen(false); setCreateKind('bot'); }}>{t('play.newBot')}</button>
                  <button type="button" role="menuitem" className="create-menu__item" data-testid="play-create-group" onClick={() => { setCreateMenuOpen(false); setCreateKind('room'); }}>{t('play.group.create')}</button>
                  {botSurface ? <button type="button" role="menuitem" className="create-menu__item" onClick={() => { setCreateMenuOpen(false); setFunctionalCreate(n => n + 1); }}>{t('play.functionalGroups.create')}</button> : null}
                </div>
              ) : null}
            </div>
          </div>
          {botRemoveError ? <p role="alert" className="play-group-error">{botRemoveError}</p> : null}
          <div className="play-sidebar__tools">
          {onSessionFilterChange ? (
            <label className="play-sidebar__search">
              <span className="sr-only">{t('play.sidebar.filterSessions')}</span>
              <input
                type="search"
                className="input-compact"
                placeholder={t('play.sidebar.filterPlaceholder')}
                autoComplete="off"
                value={sessionFilter}
                onChange={(e) => onSessionFilterChange(e.target.value)}
                aria-label={t('play.sidebar.filterAria')}
              />
            </label>
          ) : null}
          {onDeleteSessions && sessions.length ? (
            <div
              className={`play-sidebar__batch${selectMode ? ' is-selecting' : ''}`}
              role="toolbar"
              aria-label={t('play.sidebar.selectAria')}
            >
              {selectMode ? (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={deleting || !visibleIds.length}
                    aria-label={t('play.sidebar.selectAllAria')}
                    onClick={() => setCheckedIds(visibleIds)}
                  >
                    {t('play.sidebar.selectAll')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={deleting || !checkedVisible.length}
                    onClick={() =>
                      void confirmDelete(
                        checkedVisible,
                        t('play.sidebar.deleteConfirmMany', { count: checkedVisible.length })
                      )
                    }
                  >
                    {t('play.sidebar.deleteSelected', { count: checkedVisible.length })}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={deleting}
                    onClick={exitSelectMode}
                  >
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('play.sidebar.selectAria')}
                  onClick={() => setSelectMode(true)}
                >
                  {t('play.sidebar.select')}
                </button>
              )}
            </div>
          ) : null}
          </div>
          <div className="list-scroll play-sidebar__list" id="sessionListMini">
              <BotPinArea
                active={botSurface}
                bots={botRoster}
                sessions={sessions}
                renderSession={renderSession}
                onOpenSession={(sessionId) => {
                  setOpenGroupId(null);
                  onSelectSession(sessionId);
                }}
              />
            {botSurface ? (
              <PlayBotGroupList
                bots={botRoster}
                selectedId={openGroupId}
                filter={sessionFilter}
                onOpen={setOpenGroupId}
                onCount={setGroupCount}
                onDeleted={(id) => setOpenGroupId((current) => current === id ? null : current)}
              />
            ) : null}
            {botSurface ? (
              <BotFunctionalGroups bots={botRoster} sessions={sessions} renderSession={renderSession} createRequest={functionalCreate} />
            ) : !sessions.length ? (
              <div className="empty-hint">{botSurface ? t('play.sidebar.noBots') : t('play.sidebar.noSessions')}</div>
            ) : sessions.length ? (
              sessionGroups.map((group) => (
                <section key={group.bucket} className="session-date-group">
                  <h3 className="session-date-group__label">{sessionGroupDisplay(group.bucket, group.label, t)}</h3>
                  <div className="session-date-group__items">
                    {group.sessions.map(renderSession)}
                  </div>
                </section>
              ))
            ) : null}
          </div>
        </aside>

        <div className={botDetailMainClass(botDetailVisible)}>
          {botSurface && openGroupId ? <PlayBotGroupChat key={openGroupId} roomId={openGroupId} bots={botRoster} /> : null}
          <div className="play-main chat-panel" hidden={botSurface && openGroupId != null}>
            <header className={`chat-panel-header${headerBotName ? ' chat-panel-header--bot' : ''}`}>
              <div className="chat-panel-header__text">
                <div className="chat-panel-header__title-row">
                  {headerBotName ? (
                    <BotFace
                      name={headerBotName}
                      mood={headerFaceMood}
                      size="md"
                      testId="chat-header-face"
                      className="chat-panel-header__face"
                    />
                  ) : null}
                  <h2 className="chat-panel-title" id="playTitle">
                    {headerTitle}
                  </h2>
                  <BotPermissionsLink botId={headerBotId} botName={headerBotName || headerTitle} />
                  <BotDetailToggle botId={headerBotId} open={botDetailOpen} onToggle={() => setBotDetailOpen(open => !open)} />
                </div>
                {selectedSessionId ? (
                  <div className="session-chrome" id="playMeta">
                    {chrome?.status || selectedSession?.status ? (
                      <span className="session-chrome__chip">
                        <span className={statusDotClass(chrome?.status ?? selectedSession?.status ?? '')} />
                        {headerStatusText}
                      </span>
                    ) : null}
                    <span className="session-chrome__chip" title={t('play.chrome.autonomyTitle')}>
                      {t(autonomyKey(chat.autonomyLevel))}
                    </span>
                    {chrome?.usageCostUsd != null || tokens != null ? (
                      <span className="session-chrome__chip" title={t('play.chrome.costTitle')}>
                        {formatCostUsd(chrome?.usageCostUsd)}
                        {tokens != null ? ` · ${tokens} tok` : ''}
                      </span>
                    ) : null}
                    {chrome?.goalEnabled || chrome?.goalCondition ? (
                      <span
                        className={`session-chrome__chip${goalMet === true ? ' is-ok' : goalMet === false ? ' is-warn' : ''}`}
                        title={chrome?.goalCondition || t('play.chrome.noGoal')}
                      >
                        {goalMet === true ? t('play.chrome.goalMet') : t('play.chrome.goalOpen')}
                        {chrome?.goalTurnsUsed != null
                          ? ` ${chrome.goalTurnsUsed}${chrome.goalMaxTurns != null ? `/${chrome.goalMaxTurns}` : ''}`
                          : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="chat-panel-header__actions play-toolbar">
                {accountMenu}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!selectedSessionId}
                  onClick={onOpenTrace}
                  title={t('play.chrome.traceTitle')}
                >
                  {t('play.trace')}
                </button>
                {sessionBusy ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    id="btnCancelSession"
                    disabled={!selectedSessionId}
                    title={t('play.stopMenu.thisTurnHint')}
                    onClick={onCancelSession}
                  >
                    {t('play.stop')}
                  </button>
                ) : null}
                <div className="more-menu" ref={moreMenuRef}>
                  <button
                    type="button"
                    className={`btn btn-ghost btn-sm${moreMenuOpen ? ' is-open' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={moreMenuOpen}
                    aria-label={t('play.header.more')}
                    title={t('play.header.more')}
                    onClick={() => setMoreMenuOpen((v) => !v)}
                  >
                    ⋯
                  </button>
                  {moreMenuOpen ? (
                    <div className="more-menu__pop" role="menu">
                      <label
                        className="toggle toggle--compact more-menu__item"
                        title={t('play.chrome.modelViewTitle')}
                      >
                        <input
                          type="checkbox"
                          checked={chat.showModelView}
                          disabled={!selectedSessionId}
                          onChange={(e) => chat.setShowModelView(e.target.checked)}
                          aria-label={t('play.chrome.modelViewAria')}
                        />
                        <span>{t('play.modelView')}</span>
                      </label>
                      <button
                        type="button"
                        role="menuitem"
                        id="btnRunSession"
                        className="more-menu__item more-menu__action"
                        disabled={!selectedSessionId || sessionBusy}
                        title={t('play.header.runHint')}
                        onClick={() => {
                          setMoreMenuOpen(false);
                          onRunSession();
                        }}
                      >
                        {t('play.header.run')}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </header>

            <GoalStatusCard sessionId={selectedSessionId} />

            <div className="chat-panel-body">
              <div className="chat-feed-shell">
                <PlayTranscript
                  chat={chat}
                  selectedSessionId={selectedSessionId}
                  sessionApprovals={sessionApprovals}
                  turnFeedStatLines={turnFeedStatLines}
                  botSurface={botSurface}
                  footer={feedHasTurns && !statsLive ? <ChatStopReasonFooter outcome={chrome?.outcome} /> : null}
                  onOpenModelSetup={onOpenModelSetup}
                  onNewSession={onNewSession}
                  onApprovalsChanged={onApprovalsChanged}
                  onAttachStream={onAttachStream}
                />
                {chat.showJumpToLatest ? (
                  <button
                    type="button"
                    className="chat-jump-to-latest"
                    aria-label={t('play.chrome.jumpLatest')}
                    title={t('play.chrome.jumpLatest')}
                    onClick={chat.requestScrollPlayToBottom}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="m6 9 6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>
              <div className="chat-composer-outer">
                {chat.needsModelSetup && selectedSessionId ? (
                  <div className="model-setup-banner" role="status">
                    <span>{t('play.chrome.needsModel')}</span>
                    <button type="button" className="btn btn-primary btn-sm" onClick={onOpenModelSetup}>
                      {t('play.empty.setupCta')}
                    </button>
                  </div>
                ) : null}

                <label className="sr-only" htmlFor="playInput">
                  {t('play.messageContent')}
                </label>
                <div
                  className={composerClassName('chat-composer', contextDrop.over, chat.composerAckFlash)}
                  data-testid="composer-drop-target"
                  data-surface={botSurface ? 'bot' : 'chat'}
                  onDragEnter={contextDrop.onDragEnter}
                  onDragOver={contextDrop.onDragOver}
                  onDragLeave={contextDrop.onDragLeave}
                  onDrop={contextDrop.onDrop}
                >
                  <ComposerContextChips items={chat.pendingContext} onRemove={chat.removePendingContext} />
                  <textarea
                    ref={chat.playInputRef}
                    id="playInput"
                    className="chat-composer-input"
                    rows={1}
                    placeholder={
                      chatRunning
                        ? runningPlaceholder
                        : botSurface && selectedBot
                          ? t('play.messageToBot', { name: selectedBot.name })
                          : t('play.messageToAgent')
                    }
                    autoComplete="off"
                    value={chat.playInput}
                    onChange={(e) => chat.setPlayInput(e.target.value)}
                    onCompositionStart={onComposerCompositionStart}
                    onCompositionEnd={onComposerCompositionEnd}
                    onKeyDown={onComposerKeyDown}
                  />
                  {chat.speechDictationAvailable ? (
                    <button
                      type="button"
                      className={`chat-mic-btn${chat.speechDictating ? ' chat-mic-btn--active' : ''}`}
                      id="btnSpeechDictation"
                      aria-label={chat.speechDictating ? t('play.composer.dictationStop') : t('play.composer.dictation')}
                      aria-pressed={chat.speechDictating}
                      disabled={chat.playSending}
                      title={t('play.composer.dictationTitle')}
                      onClick={() => chat.toggleSpeechDictation()}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 1 1-10 0H5a7 7 0 0 0 6 6.92V20H9v2h6v-2h-2v-2.08A7 7 0 0 0 19 11h-2z" />
                      </svg>
                    </button>
                  ) : null}
                  {(chat.playSending || Boolean(chat.streamOverlay) || chat.waitTyping) ? (
                    <button
                      type="button"
                      className="chat-stop-btn"
                      id="btnStopChat"
                      aria-label={t('play.composer.stopGenerate')}
                      title={t('play.composer.stopTitle')}
                      onClick={() => onCancelSession()}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                      </svg>
                      <span>{t('play.stop')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`chat-send-btn${chatRunning && !steerDisabled ? ' chat-send-btn--steer' : ''}`}
                    id="btnSend"
                    aria-label={chatRunning ? (steerDisabled ? t('play.composer.interruptDisabled') : t('play.interrupt')) : t('play.send')}
                    title={
                      chat.workspaceAvailability.blocked
                        ? chat.workspaceAvailability.reason || t('play.composer.workspaceBlocked')
                        : chatRunning
                          ? steerDisabled
                            ? t('play.composer.interruptDisabled')
                            : immediateSteer || chat.steerInterruptPolicy !== 'queue'
                              ? t('play.composer.steerHint')
                              : t('play.composer.queueHint')
                          : t('play.send')
                    }
                    disabled={composerSendDisabled(chat.workspaceAvailability.blocked, steerDisabled, chatRunning, chat.playInput, chat.pendingContext)}
                    onClick={() => void chat.sendPlayMessage()}
                  >
                    {chat.playSending || Boolean(chat.streamOverlay) || chat.waitTyping ? (
                      <span className="chat-send-btn__steer-icon" title={t('play.composer.steerGuide')}>⚡</span>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M3.478 2.404a.75.75 0 0 0-.476.784l1.3 7.547a.75.75 0 0 0 .75.615h4.138a.25.25 0 0 1 .158.444l-3.25 2.5a.75.75 0 0 0-.116 1.14l5.9 5.9a.75.75 0 0 0 1.28-.53V4.302a.75.75 0 0 0-1.084-.672l-9.036 3.774z" />
                      </svg>
                    )}
                  </button>
                </div>

                <div className="chat-composer-dock">
                  <div className="chat-composer-dock__left">
                    <button
                      type="button"
                      className={`btn btn-ghost btn-icon btn-sm${attachOpen ? ' is-open' : ''}`}
                      aria-expanded={attachOpen}
                      aria-controls="composerAttachPanel"
                      title={t('play.attach')}
                      aria-label={t('play.attach')}
                      onClick={() => setAttachOpen((v) => !v)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      ref={configBtnRef}
                      className={`composer-config-summary${configOpen ? ' is-open' : ''}`}
                      aria-expanded={configOpen}
                      aria-controls="composerConfigPanel"
                      aria-label={
                        chat.steerInbox.length > 0
                          ? `${configOpen ? t('play.composer.configClose') : t('play.composer.configOpen')} · ${t('play.composer.configQueueBadge', { count: chat.steerInbox.length })}`
                          : configOpen
                            ? t('play.composer.configClose')
                            : t('play.composer.configOpen')
                      }
                      onClick={() => setConfigOpen((v) => !v)}
                    >
                      {t('play.settings.title')}
                      {chat.steerInbox.length > 0 ? (
                        <span className="composer-config-summary__badge">{chat.steerInbox.length}</span>
                      ) : null}
                      <span className="composer-config-summary__chevron" aria-hidden="true">
                        ▾
                      </span>
                    </button>
                    {botSurface ? (
                      <ComposerBotPicker
                        bots={botRoster.map((b) => ({ id: b.id, name: b.name }))}
                        value={chat.botId}
                        selectedName={selectedBot?.name ?? ''}
                        orphan={
                          chat.botId && !botRoster.some((b) => b.id === chat.botId)
                            ? { id: chat.botId, name: selectedBot?.name ?? chat.botId }
                            : null
                        }
                        mood={pickerFaceMood}
                        onSelect={(id) => void chat.selectBot(id)}
                      />
                    ) : null}
                    <div className="chat-composer-dock__pickers">
                    <ComposerModelPicker
                      options={enabledModelOptions}
                      modelRef={chat.modelRef}
                      defaultRef={chat.modelCatalog?.catalog.defaultRef ?? null}
                      onSelect={(next) => void chat.saveModelRef(next)}
                      onManage={onOpenModelSetup}
                      lockedReason={
                        composerModelLocked(chat.botModelOverride) ? t('play.botModel.composerLocked') : undefined
                      }
                    />
                    <WorkspacePicker
                      binding={chat.workspaceBinding}
                      bound={chat.workspaceBindingBound}
                      onBindingChange={(next) => void chat.saveWorkspaceBinding(next)}
                      onAvailabilityChange={chat.setWorkspaceAvailability}
                    />
                    </div>
                  </div>
                  <p
                    id="playStatus"
                    className={`chat-composer-hint${chat.playStatus.ok ? ' ok' : ''}${chat.playStatus.err || (!chat.playStatus.text && chat.workspaceAvailability.blocked) ? ' err' : ''}`}
                    role="status"
                  >
                    {chat.playStatus.text ||
                      (chat.workspaceAvailability.blocked
                        ? chat.workspaceAvailability.reason || t('play.composer.workspaceBlocked')
                        : chatRunning
                          ? steerDisabled
                            ? t('play.composer.statusDisabled')
                            : immediateSteer || chat.steerInterruptPolicy !== 'queue'
                              ? t('play.composer.statusSteer')
                              : t('play.composer.statusQueue')
                          : '')}
                  </p>
                </div>

                {attachOpen ? (
                  <div id="composerAttachPanel" className="composer-attach-panel">
                    <input
                      type="file"
                      id="playImageFile"
                      className="sr-only"
                      accept="image/*,.txt,.md,.csv,.json,.html,.xml,.log,.docx,.xlsx,.xlsm,.pdf"
                      multiple
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files?.length) return;
                        void chat.handleFileUpload(files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => document.getElementById('playImageFile')?.click()}
                    >
                      {t('play.composer.localFile')}
                    </button>
                    <input
                      type="url"
                      id="playImageUrl"
                      className="chat-image-url"
                      placeholder={t('play.composer.urlPlaceholder')}
                      autoComplete="off"
                      value={chat.imageUrlInput}
                      onChange={(e) => chat.setImageUrlInput(e.target.value)}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void chat.handleUrlFetch()}>
                      {t('play.composer.fetchUrl')}
                    </button>
                  </div>
                ) : null}

                {configOpen ? (
                  <SessionSettingsPanel
                    panelRef={configPanelRef}
                    chat={chat}
                    botSurface={botSurface}
                    botLocked={botLocked}
                    chatRunning={chatRunning}
                    selectedSessionId={selectedSessionId}
                    goalCommitted={chrome?.goalCondition ?? ''}
                    execPreset={execPreset}
                    agentSelectValue={agentSelectValue}
                    agentOptions={renderAgentOptions(true)}
                    onExecPreset={applyExecPreset}
                    onSupportAgent={applySupportAgent}
                    onNavigate={() => setConfigOpen(false)}
                  />
                ) : null}

                <div id="pendingImages" className="pending-images" aria-label={t('play.composer.pendingAria')}>
                  {chat.pendingImageAssetIds.map((id) => (
                    <span key={id} className="pending-img-row">
                      <span className="chip chip-muted" title={id}>
                        {t('play.composer.pendingImage', { id: id.slice(0, 14) })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => chat.setPendingImageAssetIds((x) => x.filter((y) => y !== id))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {chat.pendingAttachmentIds.map((id) => (
                    <span key={`att-${id}`} className="pending-img-row">
                      <span className="chip chip-muted" title={id}>
                        {t('play.composer.pendingAttachment', { id: id.slice(0, 12) })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => chat.setPendingAttachmentIds((x) => x.filter((y) => y !== id))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <BotDetailPane visible={botDetailVisible} botId={headerBotId} botName={headerBotName} agentId={selectedBot?.agentId} />
        </div>

        <aside className="play-rail">
          <div className="play-rail__tabs" role="tablist" aria-label={t('play.rail.aria')}>
            <button
              type="button"
              role="tab"
              className={`play-rail__tab${railTab === 'activity' ? ' active' : ''}`}
              aria-selected={railTab === 'activity'}
              onClick={() => setRailTab('activity')}
            >
              {t('play.rail.activity')}
            </button>
            <button
              type="button"
              role="tab"
              className={`play-rail__tab${railTab === 'context' ? ' active' : ''}`}
              aria-selected={railTab === 'context'}
              onClick={() => setRailTab('context')}
            >
              {t('play.rail.context')}
            </button>
            <button
              type="button"
              role="tab"
              className={`play-rail__tab${railTab === 'artifacts' ? ' active' : ''}`}
              aria-selected={railTab === 'artifacts'}
              onClick={() => setRailTab('artifacts')}
            >
              {t('play.rail.artifacts')}
            </button>
            <button
              type="button"
              role="tab"
              className={`play-rail__tab${railTab === 'trajectory' ? ' active' : ''}`}
              aria-selected={railTab === 'trajectory'}
              onClick={() => setRailTab('trajectory')}
            >
              {t('play.rail.trajectory')}
            </button>
            {botSurface ? (
              <button
                type="button"
                role="tab"
                className={`play-rail__tab${railTab === 'cron' ? ' active' : ''}`}
                aria-selected={railTab === 'cron'}
                onClick={() => setRailTab('cron')}
              >
                {t('play.cron')}
              </button>
            ) : null}
          </div>
          <div className="play-rail__body">
            {railTab === 'activity' ? (
              <ActivityPanel
                items={activityItems}
                botSessionId={selectedSessionId}
                showBotWork={botSurface}
              />
            ) : railTab === 'context' ? (
              <ContextStackPanel
                sessionId={selectedSessionId}
                running={chatRunning}
                messageCount={chat.sessionMessages.length}
              />
            ) : railTab === 'artifacts' ? (
              <ArtifactRail items={artifacts} />
            ) : railTab === 'trajectory' ? (
              <TrajectoryPanel sessionId={selectedSessionId} />
            ) : (
              <BotCronPanel botId={chat.botId || null} botName={selectedBot?.name} />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

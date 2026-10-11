'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentInfo, ApprovalItem, BotInfo, SessionSummary } from '@/lib/types';
import { visibleBotRoster, type PlaySurface } from '@/lib/bots';
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
  sliceConversationTurns,
  type TurnFeedTraceEvent
} from '@/lib/turn-feed-stats';
import { api } from '@/lib/api';
import { formatHash } from '@/lib/nav';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { messageHasStructuredParts, msgPartsToText, normalizedRole } from '@/lib/chat-utils';
import { indexResolvedToolCallIds, indexToolCalls } from '@/lib/tool-io';
import { ChatTurnFromMessage, ChatTurnPlain, ChatTurnStreaming } from './ChatTurns';
import { SurfaceContextProvider } from './a2ui/SurfaceContext';
import type { usePlayChat } from './usePlayChat';
import { ActivityPanel } from './ActivityPanel';
import { ArtifactRail } from './ArtifactRail';
import { BotCronPanel } from './BotCronPanel';
import { composerModelLocked } from '@/lib/bot-model';
import { ApprovalBanner } from './ApprovalBanner';
import { GoalStatusCard } from './GoalStatusCard';
import { TrajectoryPanel } from './TrajectoryPanel';
import { groupAgentsByDomain, sortAgentsById } from '@/lib/sort-utils';
import { groupSessionsByDate } from '@/lib/session-groups';
import { WorkspacePicker } from './WorkspacePicker';
import { catalogToPickerOptions } from '@/lib/model-providers';
import { ComposerModelPicker } from './ComposerModelPicker';
import { SessionSettingsPanel, type ExecPreset } from './sections/chat/SessionSettingsPanel';

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
  chat,
  sessionFilter = '',
  onSessionFilterChange,
  onOpenModelSetup,
  accountMenu
}: PlayPanelProps) {
  const { t } = useI18n();
  const [attachOpen, setAttachOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const prevSteerCountRef = useRef(0);
  const [railTab, setRailTab] = useState<'activity' | 'artifacts' | 'cron' | 'trajectory'>('activity');
  const flatAgents = sortAgentsById(agents);
  const supportAgents = useMemo(() => supportAgentsOf(flatAgents), [flatAgents]);
  const supportByDomain = useMemo(() => groupAgentsByDomain(supportAgents), [supportAgents]);
  const execPreset = execPresetOf(chat.agentId, chat.mode);
  const agentSelectValue = isCoreExecAgent(chat.agentId) || !chat.agentId ? '' : chat.agentId;
  const chatRunning = chat.playSending || Boolean(chat.streamOverlay) || chat.waitTyping;
  const steerDisabled = chatRunning && chat.steerInterruptPolicy === 'disabled';
  const runningPlaceholder =
    chat.steerInterruptPolicy === 'disabled'
      ? t('play.composer.runningDisabled')
      : chat.steerInterruptPolicy === 'queue'
        ? t('play.composer.runningQueue')
        : t('play.composer.runningSteer');

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
    if (n > prevSteerCountRef.current) {
      setConfigOpen(true);
    }
    prevSteerCountRef.current = n;
  }, [chat.steerInbox.length]);
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

  const renderPlayMessages = (): ReactNode => {
    if (!selectedSessionId && !chat.optimisticUser && chat.sessionMessages.length === 0 && !chat.streamOverlay && !chat.waitTyping) {
      if (chat.needsModelSetup) {
        return (
          <div className="chat-empty chat-empty--setup">
            <h3 className="chat-empty__title">{t('play.empty.setupTitle')}</h3>
            <p className="chat-empty__hint">{t('play.empty.setupHint')}</p>
            <button type="button" className="btn btn-primary btn-sm chat-empty__cta" onClick={onOpenModelSetup}>
              {t('play.empty.setupCta')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm chat-empty__cta" onClick={onNewSession}>
              {t('play.empty.setupLater')}
            </button>
          </div>
        );
      }
      return (
        <div className="chat-empty">
          <h3 className="chat-empty__title">{botSurface ? t('play.empty.selectOrCreateBot') : t('play.empty.selectOrCreateSession')}</h3>
          <p className="chat-empty__hint">
            {botSurface ? t('play.empty.hintBot') : t('play.empty.hintSession')}
          </p>
          {botSurface ? (
            <a className="btn btn-primary btn-sm chat-empty__cta" href={formatHash({ section: 'agents', sub: 'bots' })}>
              {t('play.newBot')}
            </a>
          ) : (
            <button type="button" className="btn btn-primary btn-sm chat-empty__cta" onClick={onNewSession}>
              {t('play.newSession')}
            </button>
          )}
          {botSurface ? (
            <a className="chat-empty__link" href={formatHash({ section: 'agents', sub: 'bots' })}>
              {t('play.settings.manageBots')}
            </a>
          ) : null}
        </div>
      );
    }
    const feedMessages = chat.displayMessages;
    const toolSource = chat.sessionMessages.length ? chat.sessionMessages : feedMessages;
    const toolCallsById = indexToolCalls(toolSource);
    const resolvedCallIds = indexResolvedToolCallIds(toolSource);
    if (selectedSessionId && chat.sessionMessages.length === 0 && !chat.optimisticUser && !chat.streamOverlay && !chat.waitTyping) {
      return (
        <div className="chat-empty">
          <h3 className="chat-empty__title">{t('play.empty.noMessages')}</h3>
          <p className="chat-empty__hint">
            {chat.needsModelSetup ? t('play.empty.startAfterSetup') : t('play.empty.startChat')}
          </p>
          {chat.needsModelSetup ? (
            <button
              type="button"
              className="btn btn-primary btn-sm chat-empty__cta"
              onClick={onOpenModelSetup}
            >
              {t('play.empty.setupCta')}
            </button>
          ) : null}
        </div>
      );
    }

    const nodes: ReactNode[] = [];
    let k = 0;
    const sid = selectedSessionId ?? '';
    const modelView = chat.showModelView;
    const turnSlices = sliceConversationTurns(
      feedMessages as Array<{ role?: string; createdAt?: unknown }>
    );
    const endIndexToTurn = new Map<number, number>();
    for (let ti = 0; ti < turnSlices.length; ti += 1) {
      endIndexToTurn.set(turnSlices[ti]!.endIndex, ti);
    }
    // Stream/typing without a new optimistic user → last feed turn is still open.
    const deferLastTurnStats =
      Boolean(chat.streamOverlay || chat.waitTyping) && !chat.optimisticUser;
    for (let mi = 0; mi < feedMessages.length; mi += 1) {
      const m = feedMessages[mi]!;
      if (messageHasStructuredParts(m.parts)) {
        nodes.push(
          <ChatTurnFromMessage
            key={`m${k++}`}
            m={m}
            sessionId={sid}
            msgIndex={mi}
            modelView={modelView}
            toolCallsById={toolCallsById}
            resolvedCallIds={resolvedCallIds}
          />
        );
      } else {
        const r = normalizedRole(m);
        const plain = msgPartsToText(m.parts);
        if (r === 'tool' || r === 'system') {
          nodes.push(<ChatTurnPlain key={`m${k++}`} role={r} text={plain} />);
        } else {
          nodes.push(
            <ChatTurnFromMessage
              key={`m${k++}`}
              m={m}
              sessionId={sid}
              msgIndex={mi}
              modelView={modelView}
              toolCallsById={toolCallsById}
              resolvedCallIds={resolvedCallIds}
            />
          );
        }
      }
      const turnIdx = endIndexToTurn.get(mi);
      if (turnIdx == null) continue;
      if (deferLastTurnStats && turnIdx === turnSlices.length - 1) continue;
      const line = turnFeedStatLines[turnIdx] ?? null;
      if (line) {
        nodes.push(<ChatFeedStatsFooter key={`turn-stats-${turnIdx}`} line={line} turnIndex={turnIdx} />);
      }
    }
    if (chat.optimisticUser) {
      nodes.push(<ChatTurnPlain key="opt-user" role="user" text={chat.optimisticUser} />);
    }
    if (chat.streamOverlay) {
      nodes.push(
        <ChatTurnStreaming
          key="stream"
          segments={chat.streamOverlay.segments}
          sessionId={sid}
          resolvedCallIds={resolvedCallIds}
        />
      );
    }
    if (chat.waitTyping) {
      nodes.push(<ChatTurnPlain key="wait" role="assistant" text="…" extraClass="chat-turn--typing" />);
    }
    if (deferLastTurnStats && turnSlices.length > 0) {
      const liveIdx = turnSlices.length - 1;
      const line = turnFeedStatLines[liveIdx] ?? null;
      if (line) {
        nodes.push(<ChatFeedStatsFooter key={`turn-stats-live-${liveIdx}`} line={line} turnIndex={liveIdx} />);
      }
    }
    return <>{nodes}</>;
  };

  return (
    <section className={`panel ${active ? 'active' : ''}`} id="panel-play" role="tabpanel">
      <div className="play-layout play-layout--rail">
        <aside className="play-sidebar">
          <div className="play-sidebar__head">
            <div className="play-surface-switch" role="tablist" aria-label={t('play.sidebar.modeAria')}>
              <button
                type="button"
                role="tab"
                id="playSurfaceChat"
                className={playSurface === 'chat' ? 'is-active' : ''}
                aria-selected={playSurface === 'chat'}
                onClick={() => onPlaySurfaceChange('chat')}
              >
                {t('play.chat')}
              </button>
              <button
                type="button"
                role="tab"
                id="playSurfaceBot"
                className={playSurface === 'bot' ? 'is-active' : ''}
                aria-selected={playSurface === 'bot'}
                onClick={() => onPlaySurfaceChange('bot')}
              >
                {t('play.bot')}
              </button>
            </div>
            <div className="create-menu" ref={createMenuRef}>
              <button
                type="button"
                id="btnPlayCreate"
                className={`btn btn-primary btn-sm${createMenuOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-controls="playCreateMenu"
                onClick={() => setCreateMenuOpen((v) => !v)}
              >
                {t('play.add')}
              </button>
              {createMenuOpen ? (
                <div className="create-menu__pop" id="playCreateMenu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="create-menu__item"
                    onClick={openCreateChat}
                  >
                    {t('play.chat')}
                    <span className="muted small">{t('play.newSession')}</span>
                  </button>
                  <a
                    role="menuitem"
                    className="create-menu__item"
                    href={formatHash({ section: 'agents', sub: 'bots' })}
                    onClick={() => setCreateMenuOpen(false)}
                  >
                    {t('play.bot')}
                    <span className="muted small">{t('play.newBot')}</span>
                  </a>
                </div>
              ) : null}
            </div>
          </div>
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
            {!sessions.length ? (
              <div className="empty-hint">{botSurface ? t('play.sidebar.noBots') : t('play.sidebar.noSessions')}</div>
            ) : (
              sessionGroups.map((group) => (
                <section key={group.bucket} className="session-date-group">
                  <h3 className="session-date-group__label">{sessionGroupDisplay(group.bucket, group.label, t)}</h3>
                  <div className="session-date-group__items">
                    {group.sessions.map((s) => {
                      const title = s.title || t('play.unnamed');
                      const checked = checkedVisible.includes(s.id);
                      const statusKey = sessionStatusKey(s.status);
                      return (
                        <div
                          key={s.id}
                          className={`list-item list-item--session${selectedSessionId === s.id ? ' selected' : ''}${checked ? ' is-checked' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (selectMode) {
                              toggleChecked(s.id, !checked);
                              return;
                            }
                            onSelectSession(s.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (selectMode) toggleChecked(s.id, !checked);
                              else onSelectSession(s.id);
                            }
                          }}
                        >
                          {selectMode ? (
                            <input
                              type="checkbox"
                              className="session-item__check"
                              checked={checked}
                              disabled={deleting}
                              aria-label={t('play.sidebar.checkboxAria', { title })}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => toggleChecked(s.id, e.target.checked)}
                            />
                          ) : null}
                          <div className="session-item__body">
                            <div className="session-item__title">{title}</div>
                            <div className="session-item__meta">
                              {statusKey ? (
                                <span className={`session-item__status session-item__status--${s.status}`}>
                                  <span className={statusDotClass(s.status)} aria-hidden="true" />
                                  {t(statusKey)}
                                </span>
                              ) : null}
                              {s.agentId && !isCoreExecAgent(s.agentId) ? (
                                <span className="session-item__agent">{s.agentId}</span>
                              ) : null}
                            </div>
                          </div>
                          {onDeleteSessions && !selectMode ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm session-item__delete"
                              disabled={deleting}
                              aria-label={t('play.sidebar.deleteOneAria', { title })}
                              onClick={(e) => {
                                e.stopPropagation();
                                void confirmDelete([s.id], t('play.sidebar.deleteConfirmOne', { title }));
                              }}
                            >
                              {t('play.sidebar.deleteOne')}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>
        </aside>

        <div className="play-main-col">
          <div className="play-main chat-panel">
            <header className="chat-panel-header">
              <div className="chat-panel-header__text">
                <h2 className="chat-panel-title" id="playTitle">
                  {chat.playTitle}
                </h2>
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

            <ApprovalBanner approvals={sessionApprovals} onDone={onApprovalsChanged} />
            <GoalStatusCard sessionId={selectedSessionId} />

            <div className="chat-panel-body">
              <div className="chat-feed-shell">
                <div
                  className="chat-feed"
                  id="playMessages"
                  ref={chat.playMessagesRef}
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions"
                  onScroll={chat.handlePlayMessagesScroll}
                >
                  <div className="chat-feed__track">
                    <SurfaceContextProvider messages={chat.displayMessages}>
                      {chat.showModelView ? (
                        <div className="model-view-banner" role="status">
                          {t('play.chrome.modelViewBanner', {
                            policy: chat.modelViewPayload?.policy ?? '—'
                          })}
                          {chat.modelViewPayload
                            ? t('play.chrome.modelViewStats', {
                                collapsed: chat.modelViewPayload.stats.collapsed,
                                saved: chat.modelViewPayload.stats.charsSaved
                              })
                            : ''}
                          <span className="muted">{t('play.chrome.storedFull')}</span>
                        </div>
                      ) : null}
                      {renderPlayMessages()}
                      {feedHasTurns && !statsLive ? <ChatStopReasonFooter outcome={chrome?.outcome} /> : null}
                    </SurfaceContextProvider>
                  </div>
                </div>
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
                <div className={`chat-composer${chat.composerAckFlash ? ' chat-composer--ack-flash' : ''}`}>
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
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void chat.sendPlayMessage();
                        }
                    }}
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
                            : chat.steerInterruptPolicy === 'queue'
                              ? t('play.composer.queueHint')
                              : t('play.composer.steerHint')
                          : t('play.send')
                    }
                    disabled={
                      chat.workspaceAvailability.blocked
                        ? true
                        : steerDisabled
                          ? true
                          : chatRunning
                            ? chat.playInput.trim().length === 0
                            : false
                    }
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
                      <>
                        <label className="sr-only" htmlFor="botSelect">
                          Bot
                        </label>
                        <select
                          id="botSelect"
                          className="composer-bot-select"
                          aria-label="Bot"
                          value={chat.botId}
                          onChange={(e) => void chat.selectBot(e.target.value)}
                        >
                          <option value="">{t('play.selectBot')}</option>
                          {chat.botId && !botRoster.some((b) => b.id === chat.botId) ? (
                            <option value={chat.botId}>{selectedBot?.name ?? chat.botId}</option>
                          ) : null}
                          {botRoster.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </>
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
                            : chat.steerInterruptPolicy === 'queue'
                              ? t('play.composer.statusQueue')
                              : t('play.composer.statusSteer')
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
              <ActivityPanel items={activityItems} />
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

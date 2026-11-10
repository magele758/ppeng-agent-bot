'use client';
import { setDiagnosticSession } from '@/lib/client-errors';
import { singleFlight } from '@/lib/single-flight';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react';
import { api, pollApi } from '@/lib/api';
import { BotFaceCatalog } from '../BotFaceCatalog';
import { BotWorkStateProvider } from '../bot-work/BotWorkState';
import { pendingApprovals } from '@/lib/approvals';
import { type PlaySurface } from '@/lib/bots';
import {
  DEFAULT_LOCATION,
  canonicalOpsHash,
  formatHash,
  parseHash,
  sameLocation,
  type NavLocation,
  type SectionId
} from '@/lib/nav';
import type { ModelProvidersResponse } from '@/lib/model-providers';
import { runLabTick } from '@/lib/lab-tick';
import { createOverviewCadence, refreshForPage } from '@/lib/overview-plan';
import { pageVisibility, startPollTimer } from '@/lib/poll-timer';
import { createTabReturnWatch, noteSessionStatuses, onTabVisibility, sessionStamp } from '@/lib/session-activity';
import { idleLabListState, settleList, type LabListKey, type LabListState, type ListFetch } from '@/lib/list-load';
import type { OutboundIdentity } from '@/lib/outbound-draft-preview';
import { shouldRefreshOpenSession } from '@/lib/run-leave';
import { sameData } from '@/lib/same-data';
import type {
  AgentInfo,
  ApprovalItem,
  BotInfo,
  MailItem,
  SessionSummary,
  SocialPostScheduleItem,
  TaskSummary
} from '@/lib/types';
import type { SwarmRunRow } from '../SwarmPanel';
import type { OrchestrationRunRow } from '../OrchestrationPanel';

const LIST_SCROLL_IDS = [
  'listSessions',
  'sessionListMini',
  'listTasks',
  'listSocialSchedules',
  'listApprovals',
  'listOutboundDrafts',
  'listJobs',
  'listWorkspaces',
  'listMailAll'
] as const;

function scrollSnapshot(ids: readonly string[]) {
  const snap: Record<string, { top: number; left: number }> = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) snap[id] = { top: el.scrollTop, left: el.scrollLeft };
  }
  return snap;
}

function applyScrollSnapshot(snap: Record<string, { top: number; left: number }>) {
  for (const id of Object.keys(snap)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const { top, left } = snap[id];
    el.scrollTop = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    el.scrollLeft = Math.min(left, Math.max(0, el.scrollWidth - el.clientWidth));
  }
}

export interface JobRow {
  command?: string;
  status?: string;
}

export interface WorkspaceRow {
  name?: string;
  mode?: string;
}

export interface OutboundDraftItem {
  id: string;
  channelId: string;
  text: string;
  event?: string;
  status: string;
  receiveId?: string;
  receiveIdType?: string;
  error?: string;
  createdAt: string;
  /** Bumped on every human edit; sent back on approve so a stale preview cannot send. */
  revision?: number;
  originalText?: string;
  editedAt?: string;
  identity?: OutboundIdentity;
  /** Email reply threading (r5-24/25). Read-only in Lab preview. */
  inReplyTo?: string;
  references?: string;
  subject?: string;
  replyToSubject?: string;
}

export interface ServerMeta {
  name: string;
  version: string;
  adapter?: string;
}

/** 由 Chat section 注册，供其他 section 通过 `openSession` 复用对话侧选择逻辑 */
export interface ChatBridge {
  refreshPlayPanel: () => Promise<void>;
  selectSession: (id: string) => Promise<PlaySurface>;
  applyModelCatalog: (data: ModelProvidersResponse) => void;
}

export interface LabContextValue {
  location: NavLocation;
  /** 导航；不传 sub 时取该 section 默认子页。pane 仅用于设置里的运维。 */
  navigate: (section: SectionId, sub?: string | null, pane?: string | null) => void;

  sessions: SessionSummary[];
  agents: AgentInfo[];
  bots: BotInfo[];
  setBots: React.Dispatch<React.SetStateAction<BotInfo[]>>;
  upsertBot: (bot: BotInfo) => void;
  tasks: TaskSummary[];
  socialSchedules: SocialPostScheduleItem[];
  approvals: ApprovalItem[];
  outboundDrafts: OutboundDraftItem[];
  jobs: JobRow[];
  workspaces: WorkspaceRow[];
  mailAll: MailItem[];
  swarmRuns: SwarmRunRow[];
  orchestrationRuns: OrchestrationRunRow[];
  /** Per-list load result. `error` means the last fetch failed; rows are the last success. */
  listState: LabListState;
  serverMeta: ServerMeta | null;

  autoRefresh: boolean;
  setAutoRefresh: (on: boolean) => void;
  /** 拉取概览数据；`includePlayPanel` 时同时刷新对话面板 */
  tick: (opts?: { includePlayPanel?: boolean }) => Promise<void>;
  loadOverview: () => Promise<void>;

  selectedSessionId: string | null;
  selectedSessionRef: MutableRefObject<string | null>;
  setSelectedSessionId: (id: string | null) => void;
  sessionListStickTopRef: MutableRefObject<boolean>;
  /** 选中会话；Chat section 已挂载时走其完整逻辑。`focusChat` 为真时跳转到对话页 */
  openSession: (id: string, opts?: { focusChat?: boolean }) => Promise<void>;

  modelSetupOpen: boolean;
  setModelSetupOpen: (open: boolean) => void;

  registerChatBridge: (bridge: ChatBridge | null) => void;
  getChatBridge: () => ChatBridge | null;
}

const LabContext = createContext<LabContextValue | null>(null);

export function useLab(): LabContextValue {
  const ctx = useContext(LabContext);
  if (!ctx) throw new Error('useLab must be used inside <LabProvider>');
  return ctx;
}

export function LabProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<NavLocation>(DEFAULT_LOCATION);
  const [selectedSessionId, setSelectedSessionIdState] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [socialSchedules, setSocialSchedules] = useState<SocialPostScheduleItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [outboundDrafts, setOutboundDrafts] = useState<OutboundDraftItem[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [mailAll, setMailAll] = useState<MailItem[]>([]);
  const [swarmRuns, setSwarmRuns] = useState<SwarmRunRow[]>([]);
  const [orchestrationRuns, setOrchestrationRuns] = useState<OrchestrationRunRow[]>([]);
  const [listState, setListState] = useState<LabListState>(idleLabListState);
  const [serverMeta, setServerMeta] = useState<ServerMeta | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);

  const sessionListStickTopRef = useRef(false);
  const selectedSessionRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const listStateRef = useRef(listState);
  const listsRef = useRef({
    tasks,
    socialSchedules,
    approvals,
    outboundDrafts,
    jobs,
    workspaces,
    mailAll,
    swarmRuns,
    orchestrationRuns
  });
  listStateRef.current = listState;
  listsRef.current = {
    tasks,
    socialSchedules,
    approvals,
    outboundDrafts,
    jobs,
    workspaces,
    mailAll,
    swarmRuns,
    orchestrationRuns
  };
  const chatBridgeRef = useRef<ChatBridge | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;
  const cadence = useMemo(() => createOverviewCadence({ fresh: api, shared: pollApi }), []);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // hash ⇄ location：挂载后读取（SSR 首屏固定为对话，避免 hydration 不一致）
  useEffect(() => {
    const sync = () => {
      const raw = window.location.hash;
      const redirected = canonicalOpsHash(raw);
      if (redirected) {
        const qIndex = raw.indexOf('?');
        const q = qIndex >= 0 ? raw.slice(qIndex) : '';
        window.history.replaceState(null, '', `${redirected}${q}`);
      }
      const next = parseHash(redirected ?? raw);
      setLocation((prev) => (sameLocation(prev, next) ? prev : next));
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((section: SectionId, sub?: string | null, pane?: string | null) => {
    const next = parseHash(formatHash({ section, sub: sub ?? null, pane: pane ?? null }));
    const hash = formatHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setLocation((prev) => (sameLocation(prev, next) ? prev : next));
  }, []);

  const setSelectedSessionId = useCallback((id: string | null) => {
    selectedSessionRef.current = id;
    setDiagnosticSession(id);
    setSelectedSessionIdState(id);
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const [ver, health] = await Promise.all([pollApi('/api/version'), pollApi('/api/health')]);
      const v = ver as { name?: string; version?: string };
      const h = health as { adapter?: string };
      const next = { name: v.name ?? '—', version: v.version ?? '—', adapter: h.adapter };
      setServerMeta((prev) => (sameData(prev, next) ? prev : next));
    } catch {
      setServerMeta((prev) => (prev === null ? prev : null));
    }
  }, []);

  const loadOverview = useCallback(async () => {
    const listScroll = scrollSnapshot(LIST_SCROLL_IDS);
    const sidNow = selectedSessionRef.current;
    const plan = cadence.plan(locationRef.current);
    const [sess, tasksRes, socialRes, appr, draftRes, ag, ws, jobsRes, swarmRes, orchRes, botsRes, mailRes] =
      await Promise.all([
      plan.read('/api/sessions?view=summary').catch(() => ({ sessions: undefined })),
      plan.list('tasks', async () => {
        const r = (await plan.read('/api/tasks')) as { tasks?: TaskSummary[] };
        return r.tasks ?? [];
      }),
      plan.list('socialSchedules', async () => {
        const r = (await plan.read('/api/social-post-schedules')) as { items?: SocialPostScheduleItem[] };
        return r.items ?? [];
      }),
      plan.list('approvals', async () => {
        const r = (await plan.read('/api/approvals?status=pending')) as { approvals?: ApprovalItem[] };
        return pendingApprovals(r.approvals);
      }),
      plan.list('outboundDrafts', async () => {
        const r = (await plan.read('/api/outbound-drafts')) as { drafts?: OutboundDraftItem[] };
        return r.drafts ?? [];
      }),
      plan.agents().catch(() => ({ agents: undefined })),
      plan.list('workspaces', async () => {
        const r = (await plan.read('/api/workspaces')) as { workspaces?: WorkspaceRow[] };
        return r.workspaces ?? [];
      }),
      plan.list('jobs', async () => {
        const r = (await plan.read('/api/background-jobs')) as { jobs?: JobRow[] };
        return r.jobs ?? [];
      }),
      plan.list('swarmRuns', async () => {
        const r = (await plan.read('/api/swarm/runs')) as { runs?: SwarmRunRow[] };
        return r.runs ?? [];
      }),
      plan.list('orchestrationRuns', async () => {
        const r = (await plan.read('/api/orchestration/runs')) as { runs?: OrchestrationRunRow[] };
        return r.runs ?? [];
      }),
      plan.read('/api/bots').catch(() => ({ bots: undefined })),
      plan.list('mail', async () => {
        const r = (await plan.read('/api/mailbox/all?limit=200')) as { mail?: MailItem[] };
        return r.mail ?? [];
      })
    ]);
    const sessFetched = (sess as { sessions?: SessionSummary[] }).sessions;
    const agFetched = (ag as { agents?: AgentInfo[] }).agents;
    const botsFetched = (botsRes as { bots?: BotInfo[] }).bots;
    // 拉取失败（undefined）时保留现有列表，避免瞬时错误清空会话/Agent。
    // 内容没变时保留原引用，避免 2.8s 轮询重渲染整页、冲掉文本选区。
    const sList = sessFetched ?? sessionsRef.current;
    noteSessionStatuses(sList);
    if (sessFetched) setSessions((prev) => (sameData(prev, sessFetched) ? prev : sessFetched));
    if (agFetched) setAgents((prev) => (sameData(prev, agFetched) ? prev : agFetched));
    if (botsFetched) setBots((prev) => (sameData(prev, botsFetched) ? prev : botsFetched));
    const snap = listsRef.current;
    const nextState: LabListState = { ...listStateRef.current };
    const keep = <T,>(
      key: LabListKey,
      current: T[],
      fetched: ListFetch<T>,
      commit: (update: T[] | ((prev: T[]) => T[])) => void
    ) => {
      const settled = settleList(current, nextState[key], fetched);
      nextState[key] = settled.state;
      if (!fetched.ok) return;
      commit((prev) => (sameData(prev, settled.items) ? prev : settled.items));
    };
    keep('tasks', snap.tasks, tasksRes, setTasks);
    keep('socialSchedules', snap.socialSchedules, socialRes, setSocialSchedules);
    keep('approvals', snap.approvals, appr, setApprovals);
    keep('outboundDrafts', snap.outboundDrafts, draftRes, setOutboundDrafts);
    keep('workspaces', snap.workspaces, ws, setWorkspaces);
    keep('jobs', snap.jobs, jobsRes, setJobs);
    keep('swarmRuns', snap.swarmRuns, swarmRes, setSwarmRuns);
    keep('orchestrationRuns', snap.orchestrationRuns, orchRes, setOrchestrationRuns);
    keep('mail', snap.mailAll, mailRes, setMailAll);
    listStateRef.current = nextState;
    setListState((prev) => (sameData(prev, nextState) ? prev : nextState));

    applyScrollSnapshot(listScroll);
    if (sessionListStickTopRef.current) {
      if (sidNow && sList[0]?.id === sidNow) {
        for (const id of ['listSessions', 'sessionListMini'] as const) {
          const el = document.getElementById(id);
          if (el) el.scrollTop = 0;
        }
      }
      sessionListStickTopRef.current = false;
    }
  }, [cadence]);
  const refreshOverview = useMemo(() => singleFlight(loadOverview), [loadOverview]);

  const upsertBot = useCallback((bot: BotInfo) => {
    setBots((prev) => {
      const i = prev.findIndex((b) => b.id === bot.id);
      if (i < 0) return [...prev, bot];
      const next = [...prev];
      next[i] = bot;
      return next;
    });
  }, []);

  const tick = useCallback(
    async (opts?: { includePlayPanel?: boolean }) => {
      const includePlayPanel = opts?.includePlayPanel !== false;
      await runLabTick({
        refreshMeta,
        metaDue: cadence.metaDue,
        refreshOverview,
        refreshPlayPanel: includePlayPanel ? async () => chatBridgeRef.current?.refreshPlayPanel() : undefined
      });
    },
    [refreshMeta, refreshOverview, cadence]
  );

  useEffect(() => {
    cadence.markTimer();
    void tick({ includePlayPanel: false }).finally(cadence.clearTimer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial load

  // A page that shows its own lists gets them on arrival instead of on the next timer refresh.
  const pageKey = `${location.section}/${location.sub ?? ''}`;
  const firstPageRef = useRef(true);
  useEffect(() => {
    if (firstPageRef.current) {
      firstPageRef.current = false;
      return;
    }
    void refreshForPage(refreshOverview, cadence, () => locationRef.current);
  }, [pageKey, refreshOverview, cadence]);

  const timerTick = useCallback(() => {
    const selected = sessionsRef.current.find((session) => session.id === selectedSessionRef.current);
    const includePlayPanel = shouldRefreshOpenSession({
      openSessionId: selectedSessionRef.current,
      selectedSessionId: selected?.id ?? null,
      selectedStatus: selected?.status
    });
    cadence.markTimer();
    return tick({ includePlayPanel }).finally(cadence.clearTimer);
  }, [tick, cadence, selectedSessionRef]);

  useEffect(() => {
    if (!autoRefresh) return;
    const watch = createTabReturnWatch(() => sessionStamp(selectedSessionRef.current));
    const stopTimer = startPollTimer({ run: timerTick, delayMs: () => 2800, immediate: false });
    const stopWatch = pageVisibility.subscribe(() => {
      void onTabVisibility(pageVisibility.hidden(), watch, refreshOverview, () => chatBridgeRef.current?.refreshPlayPanel());
    });
    return () => {
      stopTimer();
      stopWatch();
    };
  }, [autoRefresh, timerTick, refreshOverview, selectedSessionRef]);

  const registerChatBridge = useCallback((bridge: ChatBridge | null) => {
    chatBridgeRef.current = bridge;
  }, []);
  const getChatBridge = useCallback(() => chatBridgeRef.current, []);

  const openSession = useCallback(
    async (id: string, opts?: { focusChat?: boolean }) => {
      const bridge = chatBridgeRef.current;
      let surface: PlaySurface = 'chat';
      if (bridge) surface = await bridge.selectSession(id);
      else setSelectedSessionId(id);
      if (opts?.focusChat) navigate(surface);
    },
    [navigate, setSelectedSessionId]
  );

  const value = useMemo<LabContextValue>(
    () => ({
      location,
      navigate,
      sessions,
      agents,
      bots,
      setBots,
      upsertBot,
      tasks,
      socialSchedules,
      approvals,
      outboundDrafts,
      jobs,
      workspaces,
      mailAll,
      swarmRuns,
      orchestrationRuns,
      listState,
      serverMeta,
      autoRefresh,
      setAutoRefresh,
      tick,
      loadOverview: refreshOverview,
      selectedSessionId,
      selectedSessionRef,
      setSelectedSessionId,
      sessionListStickTopRef,
      openSession,
      modelSetupOpen,
      setModelSetupOpen,
      registerChatBridge,
      getChatBridge
    }),
    [
      location,
      navigate,
      sessions,
      agents,
      bots,
      upsertBot,
      tasks,
      socialSchedules,
      approvals,
      outboundDrafts,
      jobs,
      workspaces,
      mailAll,
      swarmRuns,
      orchestrationRuns,
      listState,
      serverMeta,
      autoRefresh,
      tick,
      refreshOverview,
      selectedSessionId,
      setSelectedSessionId,
      openSession,
      modelSetupOpen,
      registerChatBridge,
      getChatBridge
    ]
  );

  return (
    <LabContext.Provider value={value}>
      <BotWorkStateProvider><BotFaceCatalog bots={bots}>{children}</BotFaceCatalog></BotWorkStateProvider>
    </LabContext.Provider>
  );
}

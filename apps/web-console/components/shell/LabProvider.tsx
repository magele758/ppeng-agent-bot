'use client';

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
import { api } from '@/lib/api';
import { pendingApprovals } from '@/lib/approvals';
import {
  DEFAULT_LOCATION,
  formatHash,
  parseHash,
  sameLocation,
  type NavLocation,
  type SectionId
} from '@/lib/nav';
import type { ModelProvidersResponse } from '@/lib/model-providers';
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

export interface ServerMeta {
  name: string;
  version: string;
  adapter?: string;
}

/** 由 Chat section 注册，供其他 section 通过 `openSession` 复用对话侧选择逻辑 */
export interface ChatBridge {
  refreshPlayPanel: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  applyModelCatalog: (data: ModelProvidersResponse) => void;
}

export interface LabContextValue {
  location: NavLocation;
  /** 导航；不传 sub 时取该 section 默认子页 */
  navigate: (section: SectionId, sub?: string | null) => void;

  sessions: SessionSummary[];
  agents: AgentInfo[];
  bots: BotInfo[];
  setBots: React.Dispatch<React.SetStateAction<BotInfo[]>>;
  upsertBot: (bot: BotInfo) => void;
  tasks: TaskSummary[];
  socialSchedules: SocialPostScheduleItem[];
  approvals: ApprovalItem[];
  jobs: JobRow[];
  workspaces: WorkspaceRow[];
  mailAll: MailItem[];
  swarmRuns: SwarmRunRow[];
  orchestrationRuns: OrchestrationRunRow[];
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
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [mailAll, setMailAll] = useState<MailItem[]>([]);
  const [swarmRuns, setSwarmRuns] = useState<SwarmRunRow[]>([]);
  const [orchestrationRuns, setOrchestrationRuns] = useState<OrchestrationRunRow[]>([]);
  const [serverMeta, setServerMeta] = useState<ServerMeta | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);

  const sessionListStickTopRef = useRef(false);
  const selectedSessionRef = useRef<string | null>(null);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const chatBridgeRef = useRef<ChatBridge | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // hash ⇄ location：挂载后读取（SSR 首屏固定为对话，避免 hydration 不一致）
  useEffect(() => {
    const sync = () => setLocation((prev) => {
      const next = parseHash(window.location.hash);
      return sameLocation(prev, next) ? prev : next;
    });
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((section: SectionId, sub?: string | null) => {
    const next = parseHash(formatHash({ section, sub: sub ?? null }));
    const hash = formatHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setLocation((prev) => (sameLocation(prev, next) ? prev : next));
  }, []);

  const setSelectedSessionId = useCallback((id: string | null) => {
    selectedSessionRef.current = id;
    setSelectedSessionIdState(id);
  }, []);

  const refreshMeta = useCallback(async () => {
    try {
      const [ver, health] = await Promise.all([api('/api/version'), api('/api/health')]);
      const v = ver as { name?: string; version?: string };
      const h = health as { adapter?: string };
      setServerMeta({ name: v.name ?? '—', version: v.version ?? '—', adapter: h.adapter });
    } catch {
      setServerMeta(null);
    }
  }, []);

  const loadMailAll = useCallback(async () => {
    try {
      const r = (await api('/api/mailbox/all?limit=200')) as { mail?: MailItem[] };
      setMailAll(r.mail ?? []);
    } catch {
      setMailAll([]);
    }
  }, []);

  const upsertBot = useCallback((bot: BotInfo) => {
    setBots((prev) => {
      const i = prev.findIndex((b) => b.id === bot.id);
      if (i < 0) return [...prev, bot];
      const next = [...prev];
      next[i] = bot;
      return next;
    });
  }, []);

  const loadOverview = useCallback(async () => {
    const listScroll = scrollSnapshot(LIST_SCROLL_IDS);
    const sidNow = selectedSessionRef.current;
    const [sess, tasksRes, socialRes, appr, ag, ws, jobsRes, swarmRes, orchRes, botsRes] = await Promise.all([
      api('/api/sessions').catch(() => ({ sessions: undefined })),
      api('/api/tasks').catch(() => ({ tasks: [] as TaskSummary[] })),
      api('/api/social-post-schedules').catch(() => ({ items: [] as SocialPostScheduleItem[] })),
      api('/api/approvals?status=pending').catch(() => ({ approvals: [] as ApprovalItem[] })),
      api('/api/agents').catch(() => ({ agents: undefined })),
      api('/api/workspaces').catch(() => ({ workspaces: [] as WorkspaceRow[] })),
      api('/api/background-jobs').catch(() => ({ jobs: [] as JobRow[] })),
      api('/api/swarm/runs').catch(() => ({ runs: [] as SwarmRunRow[] })),
      api('/api/orchestration/runs').catch(() => ({ runs: [] as OrchestrationRunRow[] })),
      api('/api/bots').catch(() => ({ bots: undefined }))
    ]);
    const sessFetched = (sess as { sessions?: SessionSummary[] }).sessions;
    const agFetched = (ag as { agents?: AgentInfo[] }).agents;
    const botsFetched = (botsRes as { bots?: BotInfo[] }).bots;
    // 拉取失败（undefined）时保留现有列表，避免瞬时错误清空会话/Agent
    const sList = sessFetched ?? sessionsRef.current;
    if (sessFetched) setSessions(sessFetched);
    if (agFetched) setAgents(agFetched);
    if (botsFetched) setBots(botsFetched);
    setTasks((tasksRes as { tasks?: TaskSummary[] }).tasks ?? []);
    setSocialSchedules((socialRes as { items?: SocialPostScheduleItem[] }).items ?? []);
    setApprovals(pendingApprovals((appr as { approvals?: ApprovalItem[] }).approvals));
    setJobs((jobsRes as { jobs?: JobRow[] }).jobs ?? []);
    setWorkspaces((ws as { workspaces?: WorkspaceRow[] }).workspaces ?? []);
    setSwarmRuns((swarmRes as { runs?: SwarmRunRow[] }).runs ?? []);
    setOrchestrationRuns((orchRes as { runs?: OrchestrationRunRow[] }).runs ?? []);
    await loadMailAll();

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
  }, [loadMailAll]);

  const tick = useCallback(
    async (opts?: { includePlayPanel?: boolean }) => {
      const includePlayPanel = opts?.includePlayPanel !== false;
      await refreshMeta();
      await loadOverview();
      if (includePlayPanel) await chatBridgeRef.current?.refreshPlayPanel();
    },
    [refreshMeta, loadOverview]
  );

  useEffect(() => {
    void tick({ includePlayPanel: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initial load

  useEffect(() => {
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    tickTimerRef.current = null;
    if (autoRefresh) {
      tickTimerRef.current = setInterval(() => void tick({ includePlayPanel: false }), 2800);
    }
    return () => {
      if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    };
  }, [autoRefresh, tick]);

  const registerChatBridge = useCallback((bridge: ChatBridge | null) => {
    chatBridgeRef.current = bridge;
  }, []);
  const getChatBridge = useCallback(() => chatBridgeRef.current, []);

  const openSession = useCallback(
    async (id: string, opts?: { focusChat?: boolean }) => {
      const bridge = chatBridgeRef.current;
      if (bridge) await bridge.selectSession(id);
      else setSelectedSessionId(id);
      if (opts?.focusChat) navigate('chat');
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
      jobs,
      workspaces,
      mailAll,
      swarmRuns,
      orchestrationRuns,
      serverMeta,
      autoRefresh,
      setAutoRefresh,
      tick,
      loadOverview,
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
      jobs,
      workspaces,
      mailAll,
      swarmRuns,
      orchestrationRuns,
      serverMeta,
      autoRefresh,
      tick,
      loadOverview,
      selectedSessionId,
      setSelectedSessionId,
      openSession,
      modelSetupOpen,
      registerChatBridge,
      getChatBridge
    ]
  );

  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}

'use client';

import './chat.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { filterSessionsByQuery } from '@ppeng/api-types';
import { api } from '@/lib/api';
import { pickDefaultAgentId } from '@/lib/default-agent';
import { useI18n } from '@/lib/i18n';
import { leaveCancelsRun } from '@/lib/run-leave';
import { createDefaultBotLoadGuard, startDefaultBotLoadEffect } from '@/lib/bot-console-selection';
import {
  botForCanonicalSession,
  filterSessionsByPlaySurface,
  writeStoredPlaySurface,
  type PlaySurface
} from '@/lib/bots';
import type { AgentInfo, BotInfo, SessionSummary } from '@/lib/types';
import { PlayPanel } from '../../PlayPanel';
import { usePlayChat } from '../../usePlayChat';
import { useLab } from '../../shell/LabProvider';

/**
 * 对话页。常驻挂载（隐藏时仍保持流式连接与草稿），
 * 通过 ChatBridge 向 LabProvider 暴露刷新 / 选择会话能力。
 */
export function ChatSection({ active }: { active: boolean }) {
  const { t } = useI18n();
  const lab = useLab();
  const {
    sessions,
    agents,
    bots,
    approvals,
    selectedSessionId,
    selectedSessionRef,
    setSelectedSessionId,
    sessionListStickTopRef,
    upsertBot,
    tick,
    loadOverview,
    location,
    navigate,
    setModelSetupOpen,
    registerChatBridge
  } = lab;

  const [sessionSidebarFilter, setSessionSidebarFilter] = useState('');
  const [playSurface, setPlaySurfaceState] = useState<PlaySurface>('chat');
  const lastChatSessionRef = useRef<string | null>(null);
  const lastBotSessionRef = useRef<string | null>(null);
  const playSurfaceRef = useRef<PlaySurface>(playSurface);
  const sessionsRef = useRef<SessionSummary[]>([]);
  const agentsRef = useRef<AgentInfo[]>([]);
  const botsRef = useRef<BotInfo[]>([]);

  useEffect(() => {
    playSurfaceRef.current = playSurface;
  }, [playSurface]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);
  useEffect(() => {
    botsRef.current = bots;
  }, [bots]);

  const sidebarSessions = useMemo(
    () => filterSessionsByQuery(sessions, sessionSidebarFilter),
    [sessions, sessionSidebarFilter]
  );

  /** 筛选时若当前选中会话被筛掉，仍置顶展示以便高亮可见 */
  const playOpsSidebarSessions = useMemo(() => {
    const q = sessionSidebarFilter.trim();
    if (!q || !selectedSessionId) return sidebarSessions;
    if (sidebarSessions.some((s) => s.id === selectedSessionId)) return sidebarSessions;
    const cur = sessions.find((s) => s.id === selectedSessionId);
    if (!cur) return sidebarSessions;
    return [cur, ...sidebarSessions];
  }, [sessions, sidebarSessions, selectedSessionId, sessionSidebarFilter]);

  const playSidebarSessions = useMemo(() => {
    const scoped = filterSessionsByPlaySurface(playOpsSidebarSessions, bots, playSurface);
    if (!selectedSessionId) return scoped;
    if (scoped.some((s) => s.id === selectedSessionId)) return scoped;
    const cur = playOpsSidebarSessions.find((s) => s.id === selectedSessionId);
    if (!cur) return scoped;
    if (filterSessionsByPlaySurface([cur], bots, playSurface).length === 0) return scoped;
    return [cur, ...scoped];
  }, [playOpsSidebarSessions, bots, playSurface, selectedSessionId]);

  const setPlaySurface = useCallback((next: PlaySurface) => {
    playSurfaceRef.current = next;
    setPlaySurfaceState(next);
    writeStoredPlaySurface(next);
  }, []);

  const chat = usePlayChat({
    selectedSessionId,
    setSelectedSessionId,
    selectedSessionRef,
    sessionListStickTopRef,
    agents,
    bots,
    upsertBot,
    playSurface,
    onPlaySurfaceChange: setPlaySurface,
    tick
  });

  const defaultBotGuardRef = useRef<ReturnType<typeof createDefaultBotLoadGuard> | null>(null);
  if (defaultBotGuardRef.current === null) defaultBotGuardRef.current = createDefaultBotLoadGuard();
  const defaultBotGuard = defaultBotGuardRef.current;
  useEffect(() => {
    return startDefaultBotLoadEffect(
      defaultBotGuard,
      { playSurface, botId: chat.botId, selectedSessionId },
      async (isCancelled) => {
        try {
          let saved = '';
          try {
            saved = localStorage.getItem('lab.selectedBot') ?? '';
          } catch {
            /* private mode */
          }
          if (saved) {
            try {
              await api(`/api/bots/${encodeURIComponent(saved)}`);
              if (isCancelled()) return;
              await chat.selectBot(saved);
              return;
            } catch {
              if (isCancelled()) return;
            }
          }
          if (isCancelled()) return;
          const data = (await api('/api/bot-work/default')) as { bot: BotInfo };
          if (isCancelled()) return;
          upsertBot(data.bot);
          await chat.selectBot(data.bot.id);
        } catch (e) {
          if (!isCancelled()) chat.setPlayStatus({ text: String(e), err: true });
        }
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chat callbacks are unstable; rerunning cancels the load that selects the bot.
  }, [defaultBotGuard, playSurface, selectedSessionId]);

  // Bot 表面锁定 bot.agentId；否则跟随会话 / 默认 Agent。
  // 必须在绘制前写上：目录按 id 排序，第一项是没有 bash 的 capability-prober，
  // 绘制后的 effect 会给「发送」留出一帧空 agentId，新会话就会落到它上面。
  useLayoutEffect(() => {
    if (playSurface === 'bot' && chat.botId) {
      const bot = bots.find((b) => b.id === chat.botId);
      if (bot) chat.setAgentId(bot.agentId);
      return;
    }
    const sid = selectedSessionRef.current;
    const sess = sid ? sessionsRef.current.find((s) => s.id === sid) : undefined;
    if (sess?.agentId) {
      chat.setAgentId(sess.agentId);
      return;
    }
    chat.setAgentId((prev: string) => {
      if (prev && (agents.length === 0 || agents.some((a) => a.id === prev))) return prev;
      return pickDefaultAgentId(agents);
    });
  }, [agents, bots, chat.botId, playSurface]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteSessions = async (ids: string[]) => {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!unique.length) return;
    try {
      if (unique.length === 1) {
        await api(`/api/sessions/${encodeURIComponent(unique[0]!)}`, { method: 'DELETE' });
      } else {
        await api('/api/sessions/bulk-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: unique })
        });
      }
      if (selectedSessionRef.current && unique.includes(selectedSessionRef.current)) {
        setSelectedSessionId(null);
      }
      await loadOverview();
      await chat.refreshPlayPanel();
    } catch (e) {
      chat.setPlayStatus({
        text: t('play.sidebar.deleteFailed', {
          detail: e instanceof Error ? e.message : String(e)
        }),
        err: true
      });
      throw e;
    }
  };

  const selectSession = useCallback(
    async (id: string): Promise<PlaySurface> => {
      setSelectedSessionId(id);
      const match = botForCanonicalSession(botsRef.current, id, sessionsRef.current);
      const surface: PlaySurface = match ? 'bot' : 'chat';
      if (match) {
        lastBotSessionRef.current = id;
        setPlaySurface('bot');
        chat.applyBotSelection(match);
      } else {
        lastChatSessionRef.current = id;
        setPlaySurface('chat');
        chat.applyBotSelection(null);
        const sess = sessionsRef.current.find((s) => s.id === id);
        if (sess?.agentId) chat.setAgentId(sess.agentId);
      }
      const panel = chat.refreshPlayPanel();
      await loadOverview();
      await panel;
      chat.requestScrollPlayToBottom();
      return surface;
    },
    [chat, loadOverview, setPlaySurface, setSelectedSessionId]
  );

  const applySurface = (next: PlaySurface) => {
    if (next === playSurfaceRef.current) return;
    setPlaySurface(next);
    if (next === 'chat') {
      chat.applyBotSelection(null);
      const current = selectedSessionRef.current;
      if (current && botForCanonicalSession(botsRef.current, current, sessionsRef.current)) {
        let fallback = lastChatSessionRef.current;
        if (fallback && !sessionsRef.current.some((s) => s.id === fallback)) {
          fallback = null;
          lastChatSessionRef.current = null;
        }
        setSelectedSessionId(fallback);
        const restored = fallback ? sessionsRef.current.find((s) => s.id === fallback) : undefined;
        chat.setAgentId(restored?.agentId || pickDefaultAgentId(agentsRef.current));
        void loadOverview().then(() => chat.refreshPlayPanel());
      } else {
        const curSess = current ? sessionsRef.current.find((s) => s.id === current) : undefined;
        chat.setAgentId(curSess?.agentId || pickDefaultAgentId(agentsRef.current));
      }
      return;
    }
    const current = selectedSessionRef.current;
    if (current && botForCanonicalSession(botsRef.current, current, sessionsRef.current)) return;
    const fallback = lastBotSessionRef.current;
    if (fallback && botForCanonicalSession(botsRef.current, fallback, sessionsRef.current)) {
      void selectSession(fallback);
      return;
    }
    setSelectedSessionId(null);
    void loadOverview().then(() => chat.refreshPlayPanel());
  };

  const applySurfaceRef = useRef(applySurface);
  applySurfaceRef.current = applySurface;

  useEffect(() => {
    if (location.section === 'chat' || location.section === 'bot') {
      applySurfaceRef.current(location.section);
    }
  }, [location.section]);

  const onPlaySurfaceChange = (next: PlaySurface) => {
    if (location.section !== next) navigate(next);
    applySurface(next);
  };

  const bridgeRef = useRef({
    refreshPlayPanel: chat.refreshPlayPanel,
    selectSession,
    applyModelCatalog: chat.applyModelCatalog
  });
  bridgeRef.current = {
    refreshPlayPanel: chat.refreshPlayPanel,
    selectSession,
    applyModelCatalog: chat.applyModelCatalog
  };
  useEffect(() => {
    registerChatBridge({
      refreshPlayPanel: () => bridgeRef.current.refreshPlayPanel(),
      selectSession: (id) => bridgeRef.current.selectSession(id),
      applyModelCatalog: (data) => bridgeRef.current.applyModelCatalog(data)
    });
    return () => registerChatBridge(null);
  }, [registerChatBridge]);

  return (
    <PlayPanel
      active={active}
      sessions={playSidebarSessions}
      agents={agents}
      bots={bots}
      playSurface={playSurface}
      onPlaySurfaceChange={onPlaySurfaceChange}
      approvals={approvals}
      selectedSessionId={selectedSessionId}
      onSelectSession={(id) => void selectSession(id)}
      onDeleteSessions={deleteSessions}
      onNewSession={() => {
        chat.applyBotSelection(null);
        setSelectedSessionId(null);
        chat.setAgentId(pickDefaultAgentId(agents));
        void loadOverview().then(() => chat.refreshPlayPanel());
      }}
      onRunSession={() =>
        void api(`/api/sessions/${selectedSessionId}/run`, { method: 'POST' }).then(() =>
          tick({ includePlayPanel: true })
        )
      }
      onCancelSession={() => {
        if (!selectedSessionId || !leaveCancelsRun('stop')) return;
        void api(`/api/sessions/${selectedSessionId}/cancel`, { method: 'POST' }).then(() => tick());
      }}
      onOpenTrace={() => navigate('settings', 'ops', 'trajectory')}
      onApprovalsChanged={() => void tick({ includePlayPanel: true })}
      onAttachStream={(sessionId) => chat.armLiveSessionStream(sessionId)}
      chat={chat}
      sessionFilter={sessionSidebarFilter}
      onSessionFilterChange={setSessionSidebarFilter}
      onOpenModelSetup={() => setModelSetupOpen(true)}
    />
  );
}

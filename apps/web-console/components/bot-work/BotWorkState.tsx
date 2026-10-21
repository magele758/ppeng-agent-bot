'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { parseBotWorkStates, parseBotWorkOverview, type BotWorkStates, type BotWorkOverview } from '@/lib/bot-work-state';
import type { LivingFaceMood } from '@/lib/bot-face';
import { ConnectionNotice } from './ConnectionNotice';

const EMPTY: BotWorkStates = {};
const BotWorkContext = createContext<BotWorkStates>(EMPTY);
const BotOverviewContext = createContext<BotWorkOverview>({});

/** Keep the last confirmed snapshot through outages and label it as stale. */
export function BotWorkStateProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<BotWorkStates>(EMPTY);
  const [overview, setOverview] = useState<BotWorkOverview>({});
  const [disconnected, setDisconnected] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const snapshot = await api('/api/bot-work/status', {signal: controller.signal});
        const next = parseBotWorkStates(snapshot);
        if (!disposed) {
          setStates(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          const summary = parseBotWorkOverview(snapshot);
          setOverview(previous => JSON.stringify(previous) === JSON.stringify(summary) ? previous : summary);
          setLastUpdatedAt(new Date().toISOString());
          setDisconnected(false);
        }
      } catch {
        if (!disposed) setDisconnected(true);
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <BotOverviewContext.Provider value={overview}><BotWorkContext.Provider value={states}>
    <ConnectionNotice disconnected={disconnected} lastUpdatedAt={lastUpdatedAt} testId="bot-work-connection" />
    {children}
  </BotWorkContext.Provider></BotOverviewContext.Provider>;
}

export function useBotWorkOverview(): BotWorkOverview { return useContext(BotOverviewContext); }
export function useBotWorkStates(): BotWorkStates { return useContext(BotWorkContext); }
export function useBotWorkMood(botId: string | null | undefined): LivingFaceMood {
  const states = useBotWorkStates();
  return botId && states[botId] > 0 ? 'thinking' : 'idle';
}

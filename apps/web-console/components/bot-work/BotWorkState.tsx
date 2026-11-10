'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { parseBotWorkStates, parseBotWorkOverview, type BotWorkStates, type BotWorkOverview } from '@/lib/bot-work-state';
import type { LivingFaceMood } from '@/lib/bot-face';
import { ConnectionNotice } from './ConnectionNotice';

import { useDesktopNotices } from './DesktopNotices';

type PollFailure = 'botWork.connectionUnconfirmed' | 'botWork.statusSlow' | 'botWork.statusUnavailable';

function failureMessage(failures: number, timedOut: boolean, error: unknown): PollFailure | undefined {
  if (failures < 2) return undefined;
  if (timedOut) return 'botWork.statusSlow';
  return error instanceof TypeError ? 'botWork.connectionUnconfirmed' : 'botWork.statusUnavailable';
}

const EMPTY: BotWorkStates = {};
const BotWorkContext = createContext<BotWorkStates>(EMPTY);
const BotOverviewContext = createContext<BotWorkOverview>({});

/** Keep the last confirmed snapshot through outages and label it as stale. */
export function BotWorkStateProvider({ children }: { children: ReactNode }) {
  const notice = useDesktopNotices();
  const [states, setStates] = useState<BotWorkStates>(EMPTY);
  const [overview, setOverview] = useState<BotWorkOverview>({});
  const [failure, setFailure] = useState<PollFailure>();
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  useEffect(() => {
    let failures = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 5000);
      try {
        const snapshot = await api('/api/bot-work/status', {signal: request.signal});
        const next = parseBotWorkStates(snapshot);
        if (!disposed) {
          notice.current(snapshot);
          setStates(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          const summary = parseBotWorkOverview(snapshot);
          setOverview(previous => JSON.stringify(previous) === JSON.stringify(summary) ? previous : summary);
          setLastUpdatedAt(new Date().toISOString());
          failures = 0;
          setFailure(undefined);
        }
      } catch (error) {
        failures++;
        if (!disposed) setFailure(failureMessage(failures, request.signal.aborted, error));
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(poll, Math.min(8000, 1000 * Math.max(1, failures)));
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <BotOverviewContext.Provider value={overview}><BotWorkContext.Provider value={states}>
    <ConnectionNotice className="bot-work-connection-notice" disconnected={Boolean(failure)} messageKey={failure} lastUpdatedAt={lastUpdatedAt} testId="bot-work-connection" />
    {children}
  </BotWorkContext.Provider></BotOverviewContext.Provider>;
}

export function useBotWorkOverview(): BotWorkOverview { return useContext(BotOverviewContext); }
export function useBotWorkStates(): BotWorkStates { return useContext(BotWorkContext); }
export function useBotWorkMood(botId: string | null | undefined): LivingFaceMood {
  const states = useBotWorkStates();
  return botId && states[botId] > 0 ? 'thinking' : 'idle';
}

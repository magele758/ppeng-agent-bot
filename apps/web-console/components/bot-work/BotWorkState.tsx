'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { parseBotWorkStates, type BotWorkStates } from '@/lib/bot-work-state';
import type { LivingFaceMood } from '@/lib/bot-face';

const EMPTY: BotWorkStates = {};
const BotWorkContext = createContext<BotWorkStates>(EMPTY);

/** One live snapshot for all avatars, independent of the selected conversation.
 * A failed snapshot expires active state rather than leaving avatars busy forever. */
export function BotWorkStateProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<BotWorkStates>(EMPTY);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const next = parseBotWorkStates(await api('/api/bot-work/status', {signal: controller.signal}));
        if (!disposed) setStates(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      } catch {
        if (!disposed) setStates(EMPTY);
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <BotWorkContext.Provider value={states}>{children}</BotWorkContext.Provider>;
}

export function useBotWorkStates(): BotWorkStates { return useContext(BotWorkContext); }
export function useBotWorkMood(botId: string | null | undefined): LivingFaceMood {
  const states = useBotWorkStates();
  return botId && states[botId] > 0 ? 'thinking' : 'idle';
}

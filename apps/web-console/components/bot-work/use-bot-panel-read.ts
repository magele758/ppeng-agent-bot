"use client";

import { useEffect, useRef } from "react";
import { createGenerationGuard } from "@/lib/bot-console-selection";
import { readBotPanel } from "@/lib/bot-panel-reset";

export function useBotPanelRead(botId: string) {
  const generations = useRef(createGenerationGuard());
  const selectedBotId = useRef(botId);
  selectedBotId.current = botId;

  useEffect(() => {
    const current = generations.current;
    return () => {
      current.invalidate();
    };
  }, [botId]);

  return {
    selected(): string {
      return selectedBotId.current;
    },
    read<T>(requestedBotId: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
      return readBotPanel({
        selectedBotId: () => selectedBotId.current,
        requestedBotId,
        begin: () => generations.current.begin(),
        isCurrent: (generation) => generations.current.isCurrent(generation),
        signal,
        read: load
      });
    }
  };
}

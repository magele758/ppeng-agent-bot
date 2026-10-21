'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import {
  BOT_FIRST_TASK_SENT_EVENT,
  botFirstTaskPhase,
  botOutreachTargets,
  findBotUserMessage,
  historyHasUserMessage,
  noteBotFirstTaskSent,
  readBotFirstTaskAnchor,
  readBotFirstTaskDismissed,
  readBotFirstTaskDraft,
  readBotFirstTaskSent,
  writeBotFirstTaskAnchor,
  writeBotFirstTaskDismissed,
  writeBotFirstTaskDraft,
  type BotFirstTaskConversation,
  type BotFirstTaskPhase,
  type UserMessageProbe
} from '@/lib/bot-first-task';

async function probeSession(id: string): Promise<UserMessageProbe> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/history?role=user&limit=1`);
    if (response.status === 404) return 'no';
    if (!response.ok) return 'unknown';
    const data = await response.json() as { messages?: unknown };
    return historyHasUserMessage(data.messages) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

export function useBotFirstTask(input: {
  botId: string;
  conversation: BotFirstTaskConversation;
  sessions: readonly SessionSummary[];
  bots: readonly BotInfo[];
  currentSessionId: string | null;
  playInput: string;
  setPlayInput: (value: string) => void;
}): { phase: BotFirstTaskPhase; dismiss: () => void; storageFailed: boolean } {
  const { botId, conversation, sessions, bots, currentSessionId, playInput, setPlayInput } = input;
  const [storageReady, setStorageReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sentFlag, setSentFlag] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [accountSent, setAccountSent] = useState<boolean | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const hydratedBot = useRef<string | null>(null);

  useEffect(() => {
    try {
      const storedDismissed = readBotFirstTaskDismissed(window.localStorage);
      const storedSent = readBotFirstTaskSent(window.localStorage);
      setDismissed(storedDismissed);
      setSentFlag(storedSent);
      setAnchor(readBotFirstTaskAnchor(window.localStorage));
      if (storedSent) setAccountSent(true);
    } catch {
      /* private mode */
    }
    setStorageReady(true);
  }, []);

  useEffect(() => {
    const onSent = () => {
      setSentFlag(true);
      setAccountSent(true);
    };
    window.addEventListener(BOT_FIRST_TASK_SENT_EVENT, onSent);
    return () => window.removeEventListener(BOT_FIRST_TASK_SENT_EVENT, onSent);
  }, []);

  const targets = useMemo(
    () => botOutreachTargets(sessions, bots, currentSessionId),
    [sessions, bots, currentSessionId]
  );
  const targetKey = `${targets.join('|')}:${sessions.map((session) => `${session.id}@${session.updatedAt ?? ''}`).join(',')}`;

  useEffect(() => {
    if (!storageReady || dismissed || sentFlag || bots.length === 0 || targets.length === 0) return;
    let cancelled = false;
    void findBotUserMessage(targets, probeSession, () => cancelled).then((result) => {
      if (cancelled) return;
      if (result === 'yes') {
        noteBotFirstTaskSent();
        setSentFlag(true);
        setAccountSent(true);
        return;
      }
      if (result === 'no') setAccountSent(false);
    });
    return () => {
      cancelled = true;
    };
  }, [storageReady, dismissed, sentFlag, bots.length, targetKey, targets]);

  const phase = botFirstTaskPhase({
    botId,
    conversation,
    storageReady,
    dismissed,
    sent: sentFlag,
    accountSent,
    anchorBotId: anchor
  });

  useEffect(() => {
    if (phase !== 'visible' || !botId || anchor === botId) return;
    try {
      writeBotFirstTaskAnchor(window.localStorage, botId);
    } catch {
      /* private mode */
    }
    setAnchor(botId);
  }, [phase, botId, anchor]);

  useLayoutEffect(() => {
    if (phase !== 'visible' || !botId) {
      hydratedBot.current = null;
      return;
    }
    try {
      if (hydratedBot.current !== botId) {
        hydratedBot.current = botId;
        const saved = readBotFirstTaskDraft(window.localStorage, botId);
        if (typeof saved === 'string' && saved !== playInput) {
          setPlayInput(saved);
          return;
        }
      }
      writeBotFirstTaskDraft(window.localStorage, botId, playInput);
    } catch {
      /* private mode */
    }
  }, [phase, botId, playInput, setPlayInput]);

  const dismiss = useCallback(() => {
    try {
      writeBotFirstTaskDismissed(window.localStorage);
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
    setDismissed(true);
  }, []);

  return { phase, dismiss, storageFailed };
}

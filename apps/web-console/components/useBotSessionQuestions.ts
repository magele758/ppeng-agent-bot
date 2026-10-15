'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { api } from '@/lib/api';
import {
  displayedQuestion,
  isSingleBotChat,
  lastUserQuestion,
  type QuestionMessage
} from '@/lib/session-row';

function cacheKey(session: { id: string; updatedAt?: string }): string {
  return `${session.id}:${session.updatedAt ?? ''}`;
}

/**
 * Last user question for each single-bot chat in the sidebar.
 * The open session prefers text already on screen, including the in-flight send.
 */
export function useBotSessionQuestions(input: {
  sessions: readonly SessionSummary[];
  bots: readonly BotInfo[];
  selectedSessionId: string | null;
  selectedMessages: readonly QuestionMessage[];
  pendingQuestion: string | null;
}): ReadonlyMap<string, string> {
  const { sessions, bots, selectedSessionId, selectedMessages, pendingQuestion } = input;
  const cacheRef = useRef(new Map<string, string>());
  const [fetchedAt, setFetchedAt] = useState(0);
  const liveSnap = useRef({
    sessionId: null as string | null,
    messages: selectedMessages,
    pending: pendingQuestion,
    fresh: false
  });

  const targets = useMemo(
    () => sessions.filter((session) => isSingleBotChat(session, bots)),
    [sessions, bots]
  );
  const targetKey = targets.map((session) => cacheKey(session)).join('|');
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    const jobs = targetsRef.current
      .map((session) => ({ id: session.id, key: cacheKey(session) }))
      .filter((job) => !cacheRef.current.has(job.key));
    if (!jobs.length) return;
    let cancelled = false;
    void Promise.all(
      jobs.map(async (job) => {
        try {
          const data = (await api(
            `/api/sessions/${encodeURIComponent(job.id)}/history?role=user&limit=4`
          )) as { messages?: QuestionMessage[] };
          const messages = Array.isArray(data.messages) ? data.messages : [];
          return [job.key, lastUserQuestion(messages)] as const;
        } catch {
          return [job.key, ''] as const;
        }
      })
    ).then((rows) => {
      for (const [key, text] of rows) {
        if (!cacheRef.current.has(key)) cacheRef.current.set(key, text);
      }
      if (!cancelled) setFetchedAt((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [targetKey]);

  const prev = liveSnap.current;
  if (prev.sessionId !== selectedSessionId) {
    const switched = prev.sessionId !== null;
    const unchanged = selectedMessages === prev.messages && pendingQuestion === prev.pending;
    liveSnap.current = {
      sessionId: selectedSessionId,
      messages: selectedMessages,
      pending: pendingQuestion,
      fresh: switched ? !unchanged : true
    };
  } else if (selectedMessages !== prev.messages || pendingQuestion !== prev.pending) {
    liveSnap.current = {
      sessionId: selectedSessionId,
      messages: selectedMessages,
      pending: pendingQuestion,
      fresh: true
    };
  }
  const live = liveSnap.current.fresh ? displayedQuestion(selectedMessages, pendingQuestion) : '';

  return useMemo(() => {
    const map = new Map<string, string>();
    for (const session of targets) {
      const remote = cacheRef.current.get(cacheKey(session)) ?? '';
      map.set(session.id, session.id === selectedSessionId ? live || remote : remote);
    }
    return map;
  }, [targets, selectedSessionId, live, fetchedAt]);
}

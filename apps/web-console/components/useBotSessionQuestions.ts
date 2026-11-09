'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { displayedQuestion, isSingleBotChat, lastUserQuestion, type QuestionMessage } from '@/lib/session-row';

import type { BotInfo, SessionSummary } from '@/lib/types';

export function useVisibleQuestion(session: SessionSummary, bots: readonly BotInfo[], question: string) {
  const { id, updatedAt } = session;
  const enabled = !question && isSingleBotChat(session, bots);
  const row = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState({ id: '', text: '' });
  useEffect(() => {
    if (!enabled || !row.current) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api(`/api/sessions/${encodeURIComponent(id)}/history?role=user&limit=4`, { signal: controller.signal });
        const text = lastUserQuestion((data as { messages?: QuestionMessage[] }).messages ?? []);
        if (!controller.signal.aborted) setPreview({ id, text });
      } catch { /* Keep the previous preview on a transient failure. */ }
    };
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(row.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [id, updatedAt, enabled]);
  return { row, text: question || (preview.id === id ? preview.text : '') };
}

export function useSelectedQuestion(selectedSessionId: string | null, selectedMessages: readonly QuestionMessage[], pendingQuestion: string | null) {
  const liveSnap = useRef({
    sessionId: null as string | null,
    messages: selectedMessages,
    pending: pendingQuestion,
    fresh: false
  });

  const prev = liveSnap.current;
  const changed = selectedMessages !== prev.messages || pendingQuestion !== prev.pending;
  const switched = prev.sessionId !== selectedSessionId;
  const fresh = changed || (switched ? prev.sessionId === null : prev.fresh);
  liveSnap.current = { sessionId: selectedSessionId, messages: selectedMessages, pending: pendingQuestion, fresh };
  const text = fresh ? displayedQuestion(selectedMessages, pendingQuestion) : '';
  return (id: string) => id === selectedSessionId ? text : '';
}

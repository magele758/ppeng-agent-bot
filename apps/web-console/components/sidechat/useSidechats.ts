'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { getSidechat, sessionSidechats, type SidechatDetail } from '@/lib/sidechat-api';
import { SidechatDraftBook } from '@/lib/sidechat-editor';

export function useSidechatDraftBook() {
  return useState(() => new SidechatDraftBook())[0];
}
const noThreads: SidechatThread[] = [];
export function useSidechatThreads(sessionId: string | null) {
  const [result, setResult] = useState<{ sid: string; threads: SidechatThread[]; error?: string }>();
  const [revision, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void sessionSidechats(sessionId, controller.signal).then(
      (threads) => {
        if (!controller.signal.aborted) setResult({ sid: sessionId, threads });
      },
      (err) => {
        if (!controller.signal.aborted) setResult({ sid: sessionId, threads: [], error: String(err) });
      }
    );
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId, revision, refresh]);
  const displayed = result?.sid === sessionId ? result : undefined;
  return { threads: displayed?.threads ?? noThreads, refresh, error: displayed?.error };
}

export function useSidechatDetail(id: string | null, onSettled?: () => void) {
  const [data, setData] = useState<SidechatDetail>();
  const [fault, setFault] = useState('');
  const [revision, bump] = useState(0);
  const activeId = useRef(id);
  activeId.current = id;
  const settled = useRef<undefined | (() => void)>(onSettled);
  settled.current = onSettled;
  const notifySettled = () => settled.current?.();
  const refresh = useCallback(() => bump((n) => n + 1), []);
  useEffect(() => {
    setFault('');
    if (!id) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let generating = false;
    function showError(error: unknown) {
      if (controller.signal.aborted) return;
      setData(undefined);
      setFault(String(error));
    }
    const read = async () => {
      try {
        const next = await getSidechat(id, controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setFault('');
        if (next.thread.status === 'generating') {
          generating = true;
          timer = window.setTimeout(read, 750);
        } else if (generating) notifySettled();
      } catch (error) {
        showError(error);
      }
    };
    void read();
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [id, revision, refresh]);
  function received(detail: SidechatDetail) {
    if (activeId.current !== detail.thread.id) return;
    setData(detail);
    refresh();
  }
  return { detail: data?.thread.id === id ? data : undefined, fault, refresh, received };
}

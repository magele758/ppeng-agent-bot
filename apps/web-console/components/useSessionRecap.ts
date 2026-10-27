'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  activityRecordKey,
  armAutomaticRecap,
  buildSessionRecap,
  parseActivityRecord,
  presentSessionRecap,
  resolveLastActivityMs,
  resolveSeenAnchor,
  seenRecordKey,
  type RecapLocale,
  type RecapMessage
} from '@/lib/session-recap';

export function useSessionRecap(input: {
  sessionId: string | null;
  messages: readonly RecapMessage[];
  sessionUpdatedAt?: string | null;
  generating: boolean;
  draft: string;
  locale: RecapLocale;
  commandNonce: number;
}) {
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null);
  const [armed, setArmed] = useState(false);
  const [manual, setManual] = useState(false);
  const [seenAnchorId, setSeenAnchorId] = useState<string | null>(null);
  const seenRef = useRef<string | null>(null);
  const prevRef = useRef<{ sessionId: string | null; anchorId: string | null }>({
    sessionId: null,
    anchorId: null
  });
  const hiddenAtRef = useRef<number | null>(null);
  const commandSeenRef = useRef(0);
  const arrivalPendingRef = useRef(false);
  const recap = useMemo(() => buildSessionRecap(input.messages, input.locale), [input.messages, input.locale]);

  const seenNow = (sessionId: string) =>
    resolveSeenAnchor(window.localStorage.getItem(seenRecordKey(sessionId)), seenRef.current);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = (await api('/api/session-recap/settings')) as { settings?: { enabled?: boolean } };
        if (!cancelled) setAutoEnabled(data.settings?.enabled === false ? false : true);
      } catch {
        if (!cancelled) setAutoEnabled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (input.commandNonce === 0 || input.commandNonce === commandSeenRef.current) return;
    commandSeenRef.current = input.commandNonce;
    setManual(true);
  }, [input.commandNonce]);

  useEffect(() => {
    const sessionId = input.sessionId;
    const anchorId = recap?.anchorId ?? null;
    if (!sessionId) {
      prevRef.current = { sessionId: null, anchorId: null };
      setArmed(false);
      setManual(false);
      return;
    }
    const prev = prevRef.current;
    const sessionChanged = prev.sessionId !== sessionId;
    const anchorChanged = prev.anchorId !== anchorId;
    if (sessionChanged || (anchorChanged && !prev.anchorId)) arrivalPendingRef.current = true;
    if (sessionChanged) {
      const stored = window.localStorage.getItem(seenRecordKey(sessionId));
      seenRef.current = stored;
      setSeenAnchorId(stored);
      setManual(false);
      setArmed(false);
    } else if (anchorChanged && prev.anchorId && anchorId) {
      const at = Date.now();
      window.localStorage.setItem(activityRecordKey(sessionId), JSON.stringify({ anchorId, at }));
      setArmed(false);
    }
    prevRef.current = { sessionId, anchorId };
    if (!recap || autoEnabled == null) return;
    if (!autoEnabled) {
      arrivalPendingRef.current = false;
      return;
    }
    if (!arrivalPendingRef.current) return;
    const observed = parseActivityRecord(window.localStorage.getItem(activityRecordKey(sessionId)), recap.anchorId);
    const lastActivityMs = resolveLastActivityMs({
      messageAt: recap.lastActivityAt,
      sessionUpdatedAt: input.sessionUpdatedAt,
      observedAt: observed
    });
    arrivalPendingRef.current = false;
    if (
      armAutomaticRecap({
        enabled: true,
        completedTurns: recap.completedTurns,
        seenAnchorId: seenNow(sessionId),
        anchorId: recap.anchorId,
        now: Date.now(),
        lastActivityMs,
        awayStartedMs: null,
        arriving: true
      })
    ) {
      setArmed(true);
    }
  }, [input.sessionId, input.sessionUpdatedAt, autoEnabled, recap]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const awayStartedMs = hiddenAtRef.current;
      hiddenAtRef.current = null;
      const sessionId = input.sessionId;
      if (awayStartedMs == null || !sessionId || autoEnabled !== true || !recap) return;
      const observed = parseActivityRecord(window.localStorage.getItem(activityRecordKey(sessionId)), recap.anchorId);
      const lastActivityMs = resolveLastActivityMs({
        messageAt: recap.lastActivityAt,
        sessionUpdatedAt: input.sessionUpdatedAt,
        observedAt: observed
      });
      if (
        armAutomaticRecap({
          enabled: true,
          completedTurns: recap.completedTurns,
          seenAnchorId: seenNow(sessionId),
          anchorId: recap.anchorId,
          now: Date.now(),
          lastActivityMs,
          awayStartedMs,
          arriving: false
        })
      ) {
        setArmed(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [input.sessionId, input.sessionUpdatedAt, autoEnabled, recap]);

  const view = presentSessionRecap({
    enabled: autoEnabled === true,
    recap,
    armed,
    manual,
    generating: input.generating,
    draft: input.draft,
    seenAnchorId
  });

  useEffect(() => {
    if (!view.markSeen || !input.sessionId || !recap) return;
    window.localStorage.setItem(seenRecordKey(input.sessionId), recap.anchorId);
    seenRef.current = recap.anchorId;
    setSeenAnchorId(recap.anchorId);
  }, [view.markSeen, input.sessionId, recap]);

  return {
    shown: view.show,
    text: view.text,
    canManual: Boolean(recap && recap.completedTurns >= 1 && !input.generating),
    requestManual: () => setManual(true),
    dismiss: () => {
      setManual(false);
      setArmed(false);
    }
  };
}

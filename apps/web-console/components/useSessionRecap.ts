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
  shouldRefreshShownRecap,
  type RecapLocale,
  type RecapMessage
} from '@/lib/session-recap';

type FetchedRecap = {
  sessionId: string;
  anchorId: string;
  locale: RecapLocale;
  attempt: number;
  status: 'loading' | 'done' | 'failed';
  text: string;
};

export function useSessionRecap(input: {
  sessionId: string | null;
  messages: readonly RecapMessage[];
  sessionUpdatedAt?: string | null;
  generating: boolean;
  draft: string;
  locale: RecapLocale;
  commandNonce: number;
  pendingText: string;
  failedText: string;
}) {
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null);
  const [featureActive, setFeatureActive] = useState<boolean | null>(null);
  const [armed, setArmed] = useState(false);
  const [manual, setManual] = useState(false);
  const [seenAnchorId, setSeenAnchorId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fetched, setFetched] = useState<FetchedRecap | null>(null);
  const seenRef = useRef<string | null>(null);
  const manualRef = useRef(false);
  manualRef.current = manual;
  const prevRef = useRef<{ sessionId: string | null; anchorId: string | null }>({
    sessionId: null,
    anchorId: null
  });
  const hiddenAtRef = useRef<number | null>(null);
  const commandSeenRef = useRef(0);
  const arrivalPendingRef = useRef(false);
  const fetchedRef = useRef<FetchedRecap | null>(null);
  const flightRef = useRef<string | null>(null);
  const recap = useMemo(() => buildSessionRecap(input.messages), [input.messages]);
  fetchedRef.current = fetched;

  const seenNow = (sessionId: string) =>
    resolveSeenAnchor(window.localStorage.getItem(seenRecordKey(sessionId)), seenRef.current);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const load = async () => {
      const ticket = ++generation;
      try {
        const data = (await api('/api/session-recap/settings')) as {
          settings?: { enabled?: boolean; active?: boolean };
        };
        if (cancelled || ticket !== generation) return;
        setAutoEnabled(data.settings?.enabled === false ? false : true);
        setFeatureActive(data.settings?.active === false ? false : true);
      } catch {
        if (cancelled || ticket !== generation) return;
        setAutoEnabled(true);
        setFeatureActive(true);
      }
    };
    void load();
    const onHash = () => {
      void load();
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  useEffect(() => {
    if (input.commandNonce === 0 || input.commandNonce === commandSeenRef.current) return;
    commandSeenRef.current = input.commandNonce;
    setManual(true);
    setAttempt((n) => n + 1);
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
      if (shouldRefreshShownRecap({
        manual: manualRef.current,
        dismissed: false,
        previousAnchor: prev.anchorId,
        nextAnchor: anchorId
      })) {
        setAttempt((n) => n + 1);
      }
    }
    prevRef.current = { sessionId, anchorId };
    if (!recap || autoEnabled == null || featureActive == null) return;
    if (!autoEnabled || !featureActive) {
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
  }, [input.sessionId, input.sessionUpdatedAt, autoEnabled, featureActive, recap]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const awayStartedMs = hiddenAtRef.current;
      hiddenAtRef.current = null;
      const sessionId = input.sessionId;
      if (awayStartedMs == null || !sessionId || autoEnabled !== true || featureActive !== true || !recap) return;
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
  }, [input.sessionId, input.sessionUpdatedAt, autoEnabled, featureActive, recap]);

  const match =
    fetched &&
    fetched.sessionId === input.sessionId &&
    fetched.anchorId === recap?.anchorId &&
    fetched.locale === input.locale &&
    fetched.attempt === attempt
      ? fetched
      : null;
  const view = presentSessionRecap({
    active: featureActive === true,
    enabled: autoEnabled === true,
    recap,
    armed,
    manual,
    generating: input.generating,
    draft: input.draft,
    seenAnchorId,
    line: match?.status === 'done' ? match.text : ''
  });

  useEffect(() => {
    const sessionId = input.sessionId;
    const anchorId = recap?.anchorId ?? null;
    if (!view.show || !sessionId || !anchorId) return;
    const key = `${sessionId}\n${anchorId}\n${input.locale}\n${attempt}`;
    const current = fetchedRef.current;
    if (
      current &&
      current.sessionId === sessionId &&
      current.anchorId === anchorId &&
      current.locale === input.locale &&
      current.attempt === attempt &&
      (current.status === 'done' || current.status === 'failed')
    ) {
      return;
    }
    if (flightRef.current === key) return;
    flightRef.current = key;
    const locale = input.locale;
    const thisAttempt = attempt;
    let cancelled = false;
    const controller = new AbortController();
    setFetched({ sessionId, anchorId, locale, attempt: thisAttempt, status: 'loading', text: '' });
    void (async () => {
      try {
        const data = (await api(`/api/sessions/${sessionId}/recap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
          signal: controller.signal
        })) as { text?: unknown; anchorId?: unknown };
        if (cancelled) return;
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        const returnedAnchor = typeof data.anchorId === 'string' ? data.anchorId : '';
        if (!text || (returnedAnchor && returnedAnchor !== anchorId)) {
          setFetched({ sessionId, anchorId, locale, attempt: thisAttempt, status: 'failed', text: '' });
          return;
        }
        setFetched({ sessionId, anchorId, locale, attempt: thisAttempt, status: 'done', text });
      } catch {
        if (!cancelled) setFetched({ sessionId, anchorId, locale, attempt: thisAttempt, status: 'failed', text: '' });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (flightRef.current === key) flightRef.current = null;
    };
  }, [view.show, input.sessionId, recap?.anchorId, input.locale, attempt]);

  useEffect(() => {
    if (!view.markSeen || !input.sessionId || !recap) return;
    window.localStorage.setItem(seenRecordKey(input.sessionId), recap.anchorId);
    seenRef.current = recap.anchorId;
    setSeenAnchorId(recap.anchorId);
  }, [view.markSeen, input.sessionId, recap]);

  const text = !view.show
    ? ''
    : match?.status === 'done'
      ? view.text
      : match?.status === 'failed'
        ? input.failedText
        : input.pendingText;
  const status: 'hidden' | 'loading' | 'done' | 'failed' = !view.show
    ? 'hidden'
    : match?.status === 'done'
      ? 'done'
      : match?.status === 'failed'
        ? 'failed'
        : 'loading';

  return {
    shown: view.show,
    text,
    status,
    modelText: status === 'done' ? text : '',
    canManual: Boolean(featureActive === true && recap && recap.completedTurns >= 1 && !input.generating),
    requestManual: () => {
      setManual(true);
      setAttempt((n) => n + 1);
    },
    dismiss: () => {
      setManual(false);
      setArmed(false);
    }
  };
}

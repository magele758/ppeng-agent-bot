'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { evolutionEntryVisible } from '@/lib/evolution-surface';
import { opsPollNeedsRerun, shouldSkipOpsPoll, type SelfHealRunLike } from '@/lib/ops-health';

export interface EvolutionSnapshot {
  activeWorktrees: number;
  counts: Record<string, number>;
}

export interface OpsStatus {
  loaded: boolean;
  /** `/api/health` answered */
  reachable: boolean;
  /** `/api/readiness` verdict; null = unknown */
  ready: boolean | null;
  /** null = could not be read (e.g. missing admin permission) */
  selfHealActive: SelfHealRunLike[] | null;
  selfHealRuns: SelfHealRunLike[] | null;
  evolution: EvolutionSnapshot | null;
  updatedAt: number | null;
}

const INITIAL: OpsStatus = {
  loaded: false,
  reachable: true,
  ready: null,
  selfHealActive: null,
  selfHealRuns: null,
  evolution: null,
  updatedAt: null
};

interface StatusSub {
  withRuns: boolean;
  onStatus: (status: OpsStatus) => void;
  onBusy: (busy: boolean) => void;
}

const subs = new Set<StatusSub>();
let shared: OpsStatus = { ...INITIAL };
let timer: ReturnType<typeof setInterval> | null = null;
let armedMs = 0;
let flight: Promise<void> | null = null;
let flightIncludesRuns = false;
let pendingFollowUp = false;

function anyWantsRuns(): boolean {
  for (const sub of subs) {
    if (sub.withRuns) return true;
  }
  return false;
}

function publish(status: OpsStatus, busy: boolean): void {
  shared = status;
  for (const sub of subs) {
    sub.onStatus(status);
    sub.onBusy(busy);
  }
}

async function probeReadiness(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/readiness');
    const body = (await res.json()) as { ready?: unknown };
    return typeof body.ready === 'boolean' ? body.ready : null;
  } catch {
    return null;
  }
}

async function readStatus(withRuns: boolean): Promise<OpsStatus> {
  const [healthRes, ready, heal, runs, evo] = await Promise.all([
    fetch('/api/health').then((r) => r.ok).catch(() => false),
    probeReadiness(),
    api('/api/self-heal/status')
      .then((r) => ((r as { active?: SelfHealRunLike[] }).active ?? []) as SelfHealRunLike[])
      .catch(() => null),
    withRuns
      ? api('/api/self-heal/runs?limit=5')
          .then((r) => ((r as { runs?: SelfHealRunLike[] }).runs ?? []) as SelfHealRunLike[])
          .catch(() => null)
      : Promise.resolve(null),
    evolutionEntryVisible()
      ? api('/api/evolution/overview')
          .then((r) => {
            const o = r as { activeWorktrees?: unknown[]; counts?: Record<string, number> };
            return {
              activeWorktrees: Array.isArray(o.activeWorktrees) ? o.activeWorktrees.length : 0,
              counts: o.counts ?? {}
            } satisfies EvolutionSnapshot;
          })
          .catch(() => null)
      : Promise.resolve(null)
  ]);
  return {
    loaded: true,
    reachable: healthRes,
    ready: healthRes ? ready : null,
    selfHealActive: heal,
    selfHealRuns: withRuns ? runs : shared.selfHealRuns,
    evolution: evo,
    updatedAt: Date.now()
  };
}

function beginPoll(force: boolean): void {
  const requestedRuns = anyWantsRuns();
  if (shouldSkipOpsPoll(flight !== null)) {
    if (force || opsPollNeedsRerun(flightIncludesRuns, requestedRuns)) pendingFollowUp = true;
    return;
  }
  flightIncludesRuns = requestedRuns;
  for (const sub of subs) sub.onBusy(true);
  const capturedRuns = requestedRuns;
  flight = readStatus(capturedRuns)
    .then((next) => {
      shared = next;
    })
    .finally(() => {
      flight = null;
      flightIncludesRuns = false;
      const follow = pendingFollowUp;
      pendingFollowUp = false;
      publish(shared, false);
      if (follow && subs.size > 0) beginPoll(false);
    });
}

function armTimer(ms: number): void {
  if (timer && ms >= armedMs) return;
  if (timer) clearInterval(timer);
  armedMs = ms;
  timer = setInterval(() => {
    if (subs.size > 0) beginPoll(false);
  }, ms);
}

function disarmTimer(): void {
  if (subs.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  armedMs = 0;
}

/** Polls the cheap status endpoints. Callers share one in-flight request. */
export function useOpsStatus(opts: { pollMs?: number; withRuns?: boolean } = {}) {
  const { pollMs = 15_000, withRuns = false } = opts;
  const [status, setStatus] = useState<OpsStatus>(shared);
  const [busy, setBusy] = useState(flight !== null);

  const reload = useCallback(() => {
    beginPoll(true);
  }, []);

  useEffect(() => {
    const sub: StatusSub = { withRuns, onStatus: setStatus, onBusy: setBusy };
    subs.add(sub);
    setStatus(shared);
    setBusy(flight !== null);
    beginPoll(false);
    armTimer(pollMs);
    return () => {
      subs.delete(sub);
      disarmTimer();
    };
  }, [pollMs, withRuns]);

  return { status, busy, reload };
}

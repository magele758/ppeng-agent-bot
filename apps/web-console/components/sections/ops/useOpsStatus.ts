'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { evolutionEntryVisible } from '@/lib/evolution-surface';
import type { SelfHealRunLike } from '@/lib/ops-health';

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

async function probeReadiness(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/readiness');
    const body = (await res.json()) as { ready?: unknown };
    return typeof body.ready === 'boolean' ? body.ready : null;
  } catch {
    return null;
  }
}

/** Polls the cheap status endpoints. `withRuns` also loads the recent self-heal run history. */
export function useOpsStatus(opts: { pollMs?: number; withRuns?: boolean } = {}) {
  const { pollMs = 15_000, withRuns = false } = opts;
  const [status, setStatus] = useState<OpsStatus>(INITIAL);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
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
      if (!alive.current) return;
      setStatus((prev) => ({
        loaded: true,
        reachable: healthRes,
        ready: healthRes ? ready : null,
        selfHealActive: heal,
        selfHealRuns: withRuns ? runs : prev.selfHealRuns,
        evolution: evo,
        updatedAt: Date.now()
      }));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [withRuns]);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load, pollMs]);

  return { status, busy, reload: load };
}

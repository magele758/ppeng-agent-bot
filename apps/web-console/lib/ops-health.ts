import type { SessionSummary } from './types.ts';

export type HealthLevel = 'ok' | 'warn' | 'fail';
export type DoctorSeverity = 'ok' | 'warn' | 'fail';

export interface DoctorCheckLike {
  id: string;
  title: string;
  severity: DoctorSeverity;
  detail: string;
  hint?: string;
}

export interface DoctorReportLike {
  ok: boolean;
  checkedAt: string;
  checks: DoctorCheckLike[];
  summary: { ok: number; warn: number; fail: number };
}

export interface HealthInputs {
  /** `/api/health` answered */
  reachable: boolean;
  /** `/api/readiness` verdict; null = not known yet */
  ready: boolean | null;
  doctor: DoctorReportLike | null;
  /** Effective-config items that carry warnings */
  configWarnings: number;
  /** Failed or blocked runs in the recent self-heal history. Omitted means none known. */
  selfHealBad?: number;
}

export type HealthReason =
  | 'unreachable'
  | 'notReady'
  | 'doctorFail'
  | 'doctorWarn'
  | 'selfHealBad'
  | 'configWarn';

export interface OverallHealth {
  level: HealthLevel;
  reasons: HealthReason[];
}

/** Roll the individual signals up into one verdict; `reasons` is ordered most severe first. */
export function overallHealth(input: HealthInputs): OverallHealth {
  const reasons: HealthReason[] = [];
  if (!input.reachable) return { level: 'fail', reasons: ['unreachable'] };
  if (input.ready === false) reasons.push('notReady');
  if (input.doctor && input.doctor.summary.fail > 0) reasons.push('doctorFail');
  if (input.doctor && input.doctor.summary.warn > 0) reasons.push('doctorWarn');
  if ((input.selfHealBad ?? 0) > 0) reasons.push('selfHealBad');
  if (input.configWarnings > 0) reasons.push('configWarn');
  const level: HealthLevel =
    reasons.includes('notReady') || reasons.includes('doctorFail')
      ? 'fail'
      : reasons.length > 0
        ? 'warn'
        : 'ok';
  return { level, reasons };
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = { fail: 0, warn: 1, ok: 2 };

/** Failures and warnings first (stable within a severity); passed checks go to `passed`. */
export function splitDoctorChecks(checks: DoctorCheckLike[]): {
  attention: DoctorCheckLike[];
  passed: DoctorCheckLike[];
} {
  const sorted = checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => SEVERITY_RANK[a.c.severity] - SEVERITY_RANK[b.c.severity] || a.i - b.i)
    .map((x) => x.c);
  return {
    attention: sorted.filter((c) => c.severity !== 'ok'),
    passed: sorted.filter((c) => c.severity === 'ok')
  };
}

/** Case-insensitive match on title, agent id or session id. */
export function filterSessions<T extends Pick<SessionSummary, 'id' | 'title' | 'agentId'>>(
  sessions: T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter(
    (s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.agentId || '').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
  );
}

export interface SelfHealRunLike {
  id: string;
  status: string;
  fixIteration?: number;
  worktreeBranch?: string;
  lastErrorSummary?: string;
  blockReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SelfHealTone = 'running' | 'done' | 'bad' | 'idle';

/** Collapse the self-heal state machine into something a human can scan. */
export function selfHealTone(status: string): SelfHealTone {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'blocked':
      return 'bad';
    case 'stopped':
      return 'idle';
    default:
      return 'running';
  }
}

/** Plain-language state for a count of running jobs. */
export function activityState(count: number): 'idle' | 'running' {
  return count > 0 ? 'running' : 'idle';
}

/** How many recent runs failed or blocked. Unknown history counts as none. */
export function countSelfHealBad(runs: SelfHealRunLike[] | null | undefined): number {
  if (!runs) return 0;
  let n = 0;
  for (const run of runs) {
    if (selfHealTone(run.status) === 'bad') n += 1;
  }
  return n;
}

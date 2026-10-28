import type { SqliteStateStore } from '../storage.js';
import type { BackgroundJobRecord, SessionMessage } from '../types.js';
import type { RoutineRun } from './routine-runtime.js';
import type { RoutineWorkSnapshot } from './routine-work-link.js';

function sameExecution(expected: NonNullable<RoutineWorkSnapshot['externalJob']>, current: BackgroundJobRecord): boolean {
  return expected.id === current.id && expected.sessionId === current.sessionId && expected.createdAt === current.createdAt;
}

function containsCurrentJob(content: string, job: BackgroundJobRecord): boolean {
  try {
    const value = JSON.parse(content);
    const rows = Array.isArray(value) ? value : [value];
    return rows.some(row => matchesJob(row, job));
  } catch { return false; }
}

function matchesJob(value: unknown, job: BackgroundJobRecord): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as BackgroundJobRecord;
  return sameExecution(job, row) && row.status === job.status && row.updatedAt === job.updatedAt;
}

function observedJob(message: SessionMessage, job: BackgroundJobRecord): boolean {
  return message.parts.some(part => part.type === 'tool_result' && part.name === 'bg_check'
    && part.ok === true && containsCurrentJob(part.content, job));
}

function failedCheck(message: SessionMessage): boolean {
  return message.parts.some(part => part.type === 'tool_result' && part.name === 'bg_check' && part.ok === false);
}

/** Only this run's real bg_check of the registered execution is a current job observation. */
export function linkedJobObservation(store: SqliteStateStore, run: RoutineRun, messages: SessionMessage[]): Partial<RoutineRun> {
  const snapshot = run.workSnapshot!;
  const expected = snapshot.externalJob!;
  const job = store.getBackgroundJob(expected.id);
  if (!job || !sameExecution(expected, job)) {
    return { status: 'failed', error: 'Linked external job identity changed; work status is unverified' };
  }
  const observation = messages.findLast(message => failedCheck(message) || observedJob(message, job));
  if (!observation || failedCheck(observation)) return { status: 'failed', error: 'Current observation failed or missing for linked external job; work status is unverified' };
  // bg_check reads the registry. Reading an old row does not refresh actual worker evidence.
  if (Date.parse(job.updatedAt) < Date.parse(run.startedAt ?? run.createdAt)) {
    return { status: 'failed', error: 'Linked external job observation is stale; work status is unverified' };
  }
  const externalJob = { id: job.id, sessionId: job.sessionId, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status };
  const workSnapshot = { ...snapshot, externalJob, observedAt: job.updatedAt };
  if (job.status === 'error') return { workSnapshot, status: 'failed', error: 'Linked external job failed; delivery is unverified' };
  return { workSnapshot };
}

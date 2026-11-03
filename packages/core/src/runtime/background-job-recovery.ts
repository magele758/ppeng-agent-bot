import type { SqliteStateStore } from '../storage.js';

const INTERRUPTED_RESULT = 'Process interrupted; command was not restarted. Verify effects before retrying.';

export function sweepOrphanBackgroundJobs(store: SqliteStateStore, liveJobIds: ReadonlySet<string>): number {
  let swept = 0;
  for (const job of store.listBackgroundJobs()) {
    if (job.status !== 'running' || liveJobIds.has(job.id)) continue;
    store.updateBackgroundJob(job.id, 'error', INTERRUPTED_RESULT);
    swept += 1;
  }
  return swept;
}

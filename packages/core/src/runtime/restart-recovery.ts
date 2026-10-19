/** Recovery is startup-only: never steal a known live process's state. */
import { dirname, join } from 'node:path';
import type { SqliteStateStore } from '../storage.js';
import { tryAcquireFdLock } from '../teams/fd-lock.js';
import { isCanonicalBotChat } from '../session/bot-compact-policy.js';
import { blockHumanContinuations } from '../session/human-continuation.js';
import { parseRunInterrupt, mergeInterruptMetadata } from '../session/interrupt.js';
import { buildRunOutcome, mergeOutcomeMetadata } from '../session/run-outcome.js';
import { closeOpenToolWave } from '../session/tool-wave-close.js';

/**
 * A kernel-owned file lock guards recovery, not normal WAL authorization.
 * Another live runtime may open the store, but it must not perform boot recovery.
 * The OS releases this lock on process exit, including SIGKILL. No PID reclaim,
 * persistent ownership flags, heartbeat or lock-file deletion is needed.
 */
export function acquireRuntimeProcessOwnership(store: SqliteStateStore): { release(): void } | undefined {
  return tryAcquireFdLock(join(dirname(store.dbPath), 'runtime-recovery.lock.db'));
}

/** Called only by the boot owner, after the predecessor has relinquished state. */
export function recoverInterruptedSessions(store: SqliteStateStore): void {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const session of store.listSessions()) {
      // Bot queue and delegated child recovery retain their existing protocols.
      if (!['chat', 'task'].includes(session.mode) || isCanonicalBotChat(session)
        || typeof session.metadata?.botId === 'string') continue;
      if (store.isSessionWriterLive(session.id)) continue;
      const interrupt = parseRunInterrupt(session.metadata);
      const resumableApproval = interrupt?.kind === 'waiting_approval'
        && (session.status === 'waiting_approval'
          || (session.status === 'idle' && session.metadata?.outcome
            && (session.metadata.outcome as { kind?: string }).kind === 'waiting_approval'));
      // Keep the interrupt's logical writerRunId for a future explicit resume;
      // the dead process's active WAL claim must not block ordinary approval input.
      if (session.activeWriterRunId) store.releaseWriter(session.id, session.activeWriterRunId);
      if (resumableApproval || session.status !== 'running') continue;
      closeOpenToolWave(store, session.id, 'interrupted');
      for (const approval of store.listApprovals({ status: 'pending' })) {
        if (approval.sessionId === session.id) store.updateApproval(approval.id, 'rejected');
      }
      const outcome = buildRunOutcome({ kind: 'failed', reason: 'process_interrupted', failureStage: 'recovery' });
      store.updateSession(session.id, {
        status: 'failed',
        metadata: mergeInterruptMetadata(mergeOutcomeMetadata(session.metadata ?? {}, outcome), null)
      });
      blockHumanContinuations(store, session.id, 'process_interrupted');
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

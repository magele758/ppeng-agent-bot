/**
 * cancelSession / destroy extracted from RawAgentRuntime.
 */

import type { McpManager } from '../mcp/mcp-manager.js';
import { mergeInterruptMetadata } from '../session/interrupt.js';
import { mergeOutcomeMetadata, runOutcomeFromEnd } from '../session/run-outcome.js';
import { closeOpenToolWave } from '../session/tool-wave-close.js';
import type { SqliteStateStore } from '../storage.js';
import type { TraceEvent } from '../stores/trace.js';
import type { SessionRecord } from '../types.js';

export interface SessionControlHost {
  store: SqliteStateStore;
  sessionAbortControllers: Map<string, AbortController>;
  backgroundJobAborts: Map<string, AbortController>;
  emitTrace(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void;
}

const AUTONOMOUS_BACKGROUND_MODES: ReadonlySet<SessionRecord['mode']> = new Set(['task', 'teammate']);

/** Idle would let the next autonomous sweep start the task the user just stopped. */
function parkedCancelStatus(session: SessionRecord): 'failed' | 'idle' {
  if (session.background && AUTONOMOUS_BACKGROUND_MODES.has(session.mode)) return 'failed';
  return 'idle';
}

function releaseParkedApproval(host: SessionControlHost, session: SessionRecord): boolean {
  if (session.status !== 'waiting_approval') return false;
  for (const approval of host.store.listApprovals({ status: 'pending' })) {
    if (approval.sessionId !== session.id) continue;
    host.store.updateApproval(approval.id, 'rejected');
  }
  const metadata = session.metadata ? session.metadata : {};
  const outcome = runOutcomeFromEnd({ reason: 'abort', sessionStatus: 'failed' });
  host.store.updateSession(session.id, {
    status: parkedCancelStatus(session),
    metadata: mergeInterruptMetadata(mergeOutcomeMetadata(metadata, outcome), null)
  });
  return true;
}

export function cancelSession(host: SessionControlHost, sessionId: string): void {
  try {
    closeOpenToolWave(host.store, sessionId, 'interrupted');
  } catch {
    /* fold/append must not block abort */
  }
  const session = host.store.getSession(sessionId);
  if (session && !releaseParkedApproval(host, session)) {
    const outcome = runOutcomeFromEnd({ reason: 'abort', sessionStatus: 'failed' });
    host.store.updateSession(sessionId, {
      metadata: mergeOutcomeMetadata(session.metadata ?? {}, outcome)
    });
  }
  const controller = host.sessionAbortControllers.get(sessionId);
  controller?.abort();
  for (const jobId of [...host.backgroundJobAborts.keys()]) {
    const ac = host.backgroundJobAborts.get(jobId);
    if (!ac) continue;
    const job = host.store.getBackgroundJob(jobId);
    if (job?.sessionId === sessionId) {
      ac.abort();
      host.backgroundJobAborts.delete(jobId);
    }
  }
  void host.emitTrace(sessionId, { kind: 'cancel', payload: {} });
}

/**
 * Abort every live session run and every background job.
 * Pass `allowedSessionIds` to stop only those sessions (and their jobs).
 * Does not close the store or tear down MCP.
 */
export function cancelAllSessions(
  host: SessionControlHost,
  allowedSessionIds?: ReadonlySet<string>
): { sessionIds: string[] } {
  const restricted = allowedSessionIds !== undefined;
  const sessionIds = [...host.sessionAbortControllers.keys()].filter((id) => {
    const controller = host.sessionAbortControllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    return !restricted || allowedSessionIds.has(id);
  });
  for (const sessionId of sessionIds) {
    cancelSession(host, sessionId);
  }
  for (const [jobId, controller] of [...host.backgroundJobAborts.entries()]) {
    if (restricted) {
      let sessionId: string | undefined;
      try {
        sessionId = host.store.getBackgroundJob(jobId)?.sessionId;
      } catch {
        sessionId = undefined;
      }
      if (!sessionId || !allowedSessionIds.has(sessionId)) continue;
    }
    try {
      controller.abort();
    } catch {
      /* best effort */
    }
    host.backgroundJobAborts.delete(jobId);
  }
  return { sessionIds };
}

export async function destroyRuntime(input: {
  sessionAbortControllers: Map<string, AbortController>;
  backgroundJobAborts: Map<string, AbortController>;
  mcpManager: McpManager;
  store: SqliteStateStore;
}): Promise<void> {
  for (const ac of input.sessionAbortControllers.values()) {
    try { ac.abort(); } catch { /* best effort */ }
  }
  input.sessionAbortControllers.clear();

  for (const [, ac] of input.backgroundJobAborts) {
    try { ac.abort(); } catch { /* best effort */ }
  }
  input.backgroundJobAborts.clear();

  await input.mcpManager.destroy();

  try { input.store.db.close(); } catch { /* best effort — may already be closed */ }
}

import { claimSummaryLease, summaryLeaseCurrent, releaseSummaryLease } from './bot-summary-lease.js';
import { createHash } from 'node:crypto';
import { resolveBotWindowBudget } from '../session/history/window.js';
import { isCanonicalBotChat } from '../session/bot-compact-policy.js';
import type { RunContext } from '../types.js';
import type { TraceEvent } from '../stores/trace.js';
import { autoCompactSession, type CompactHost } from './compact-host.js';

function fingerprint(host: CompactHost, id: string): string {
  const session = host.store.getSession(id);
  const adapter = session ? host.resolveContextAdapter?.(session) ?? host.resolveModelAdapter?.(session) ?? host.modelAdapter : host.modelAdapter;
  const budget = resolveBotWindowBudget(host.store, adapter, host.turnShapeBySession.get(id));
  return createHash('sha256').update(JSON.stringify([budget, host.store.foldMessages(id).map(m => [m.id, m.parts])])).digest('hex');
}

type Job = { pending?: Promise<void>; retryAt: number; dirty?: boolean; fingerprint?: string; controller?: AbortController };
const stopped = new WeakSet<object>();
const jobs = new WeakMap<object, Map<string, Job>>();

export function scheduleBotSummary(host: CompactHost, context: RunContext, force = false): void {
  if (stopped.has(host.store) || !isCanonicalBotChat(context.session)) return;
  let sessions = jobs.get(host.store);
  if (!sessions) { sessions = new Map(); jobs.set(host.store, sessions); }
  const id = context.session.id;
  const key = 'bot.summaryAttempt:' + id;
  const inputFingerprint = fingerprint(host, id);
  const previous = host.store.getDaemonControl<{ fingerprint: string; retryAt: number }>(key);
  if (previous?.fingerprint === inputFingerprint && Date.now() < previous.retryAt && (!force || previous.retryAt !== Number.MAX_SAFE_INTEGER)) return;
  const job = sessions.get(id) ?? { retryAt: 0 };
  if (job.pending) { job.dirty ||= job.fingerprint !== inputFingerprint; return; }
  if (Date.now() < job.retryAt) return;
  const lease = claimSummaryLease(host.store, id);
  if (!lease) return;
  job.controller = new AbortController();
  job.dirty = false;
  job.fingerprint = inputFingerprint;
  sessions.set(id, job);
  // Background work must not inherit a completed interactive writer lease.
  job.pending = host.store.runWithoutWriterScope(() => host.store.runWithoutMessageSource(() =>
    new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (job.controller!.signal.aborted) { releaseSummaryLease(host.store, id, lease); return; }
      let failed = false;
      const observed = { ...host, emitTrace(sessionId: string, event: Omit<TraceEvent, 'ts' | 'sessionId'>) {
        if (event.kind === 'compact_skipped' && ['summary_timeout', 'summary_failed', 'empty_summary'].includes(String(event.payload?.reason))) failed = true;
        host.emitTrace(sessionId, event);
      }};
      try {
        await autoCompactSession(observed, context, { force, summaryTimeoutMs: 60_000, thresholdOnly: true, summarySignal: job.controller!.signal, summaryIsCurrent: () => summaryLeaseCurrent(host.store, id, lease) });
      } catch (error) {
        failed = true;
        host.emitTrace(id, { kind: 'compact_skipped', payload: { reason: 'background_failed', message: String(error) } });
      } finally {
        job.pending = undefined;
        if (failed) job.retryAt = Date.now() + 60_000;
        else sessions!.delete(id);
        try {
          if (summaryLeaseCurrent(host.store, id, lease) && (!job.dirty || failed)) {
            host.store.setDaemonControl(key, { fingerprint: fingerprint(host, id), retryAt: failed ? job.retryAt : Number.MAX_SAFE_INTEGER });
          }
          releaseSummaryLease(host.store, id, lease);
        } catch { /* Store may have closed during shutdown. */ }
        if (job.dirty && !failed) scheduleBotSummary(host, context);
      }
    })
  ));
}

export async function autoCompactForTurn(host: CompactHost, context: RunContext, opts?: { force?: boolean }) {
  if (!isCanonicalBotChat(context.session)) return autoCompactSession(host, context, opts);
  scheduleBotSummary(host, context, opts?.force === true);
  return {};
}

export function scheduleSummaryAfterTurn(host: CompactHost, context: RunContext, event: Omit<TraceEvent, 'ts' | 'sessionId'>): void {
  if (event.kind === 'turn_end') scheduleBotSummary(host, context);
}

export async function waitForBotSummary(store: object, sessionId: string): Promise<void> {
  let pending = jobs.get(store)?.get(sessionId)?.pending;
  while (pending) {
    await pending;
    pending = jobs.get(store)?.get(sessionId)?.pending;
  }
}

export async function stopBotSummaries(store: object): Promise<void> {
  stopped.add(store);
  const active = [...(jobs.get(store)?.values() ?? [])];
  for (const job of active) job.controller?.abort(new Error('Runtime shutting down'));
  await Promise.allSettled(active.map(job => job.pending));
  jobs.delete(store);
}

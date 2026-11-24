/**
 * Core Durable Control Plane boot recovery and scheduler auto-resume.
 * Every helper kept small (CC <= 5) for CRAP gate compliance.
 */

import {
  readDurableSettings,
  type DurableRunRecord,
  type DurableStepRecord,
} from '@ppeng/agent-loop';
import type { SqliteStateStore } from '../storage.js';
import { closeOpenToolWave } from '../session/tool-wave-close.js';
import type { SessionRecord } from '../types.js';

export interface DurableSchedulerHost {
  store: SqliteStateStore;
  runSession(sessionId: string): Promise<SessionRecord>;
  isSessionRunning?(sessionId: string): boolean;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

function markDispatchedStepsUnknown(store: SqliteStateStore, runId: string): DurableStepRecord[] {
  const steps = store.durableJournal.listSteps(runId);
  const updated: DurableStepRecord[] = [];
  for (const step of steps) {
    if (step.phase === 'dispatched') {
      updated.push(store.durableJournal.markStepUnknown(step.stepId, 'process_interrupted'));
    } else {
      updated.push(step);
    }
  }
  return updated;
}

function nextBootStatus(input: {
  restarts: number;
  restartLimit: number;
  mode: string;
  chatRestartPolicy: string;
}): { status: DurableRunRecord['status']; errorText?: string } {
  if (input.restarts >= input.restartLimit) {
    return { status: 'failed', errorText: `restart_limit (${input.restarts}/${input.restartLimit})` };
  }
  if (input.mode === 'off' || input.chatRestartPolicy === 'legacy_fail') {
    return { status: 'failed', errorText: 'process_interrupted' };
  }
  if (input.chatRestartPolicy === 'park_resumable') {
    return { status: 'suspended_interrupted' };
  }
  return { status: 'resumable' };
}

/**
 * Synchronous boot-time reconciliation of crashed `running` durable runs.
 * Never starts async LLM/tool execution during RawAgentRuntime construction.
 */
export function recoverDurableRunsOnBoot(store: SqliteStateStore): DurableRunRecord[] {
  const settings = readDurableSettings(store);
  const running = store.durableJournal.listRunsByStatus(['running']);
  const settled: DurableRunRecord[] = [];
  for (const run of running) {
    if (store.isSessionWriterLive(run.sessionId)) continue;
    markDispatchedStepsUnknown(store, run.runId);
    const restarts = run.restarts + 1;
    const next = nextBootStatus({
      restarts,
      restartLimit: settings.restartLimit,
      mode: settings.mode,
      chatRestartPolicy: settings.chatRestartPolicy,
    });
    settled.push(
      store.durableJournal.updateRun(run.runId, {
        status: next.status,
        restarts,
        ...(next.errorText ? { errorText: next.errorText } : {}),
      })
    );
  }
  return settled;
}

const CANCELLABLE_RUN_STATUSES = new Set<DurableRunRecord['status']>([
  'running',
  'resumable',
  'suspended_interrupted',
  'waiting_park',
]);

/**
 * Mark active/resumable durable runs for a session as cancelled so the
 * scheduler will not auto-resume a session the user explicitly stopped.
 */
export function cancelDurableRunsForSession(store: SqliteStateStore, sessionId: string): number {
  const runs = store.durableJournal.listRunsForSession(sessionId, 10);
  let count = 0;
  for (const run of runs) {
    if (!CANCELLABLE_RUN_STATUSES.has(run.status)) continue;
    store.durableJournal.updateRun(run.runId, { status: 'aborted' });
    count += 1;
  }
  return count;
}

/**
 * Close only unsafe/non-resumable open tool calls during boot recovery so that
 * `planned` and `replay:'safe'` calls remain open for durable resume while
 * `replay:'unsafe'` interrupted calls are immediately closed as interrupted.
 */
export function closeUnsafeOpenToolCallsOnBoot(store: SqliteStateStore, sessionId: string): void {
  const settings = readDurableSettings(store);
  const latest = store.durableJournal.getLatestRunForSession(sessionId);
  if (settings.mode === 'off' || !latest || (latest.status !== 'resumable' && latest.status !== 'suspended_interrupted')) {
    closeOpenToolWave(store, sessionId, 'interrupted');
    return;
  }
  const steps = store.durableJournal.listSteps(latest.runId);
  const keepOpen = new Set<string>();
  for (const step of steps) {
    if (!step.toolCallId) continue;
    if (step.phase === 'planned') keepOpen.add(step.toolCallId);
    if (step.phase === 'unknown' && step.replayPolicy === 'safe') keepOpen.add(step.toolCallId);
  }
  if (keepOpen.size === 0) {
    closeOpenToolWave(store, sessionId, 'interrupted');
    return;
  }
  const folded = store.foldMessages(sessionId);
  const unsafeIds: string[] = [];
  const closed = new Set<string>();
  for (const msg of folded) {
    for (const part of msg.parts) {
      if (part.type === 'tool_result') closed.add(part.toolCallId);
    }
  }
  for (const msg of folded) {
    for (const part of msg.parts) {
      if (part.type === 'tool_call' && !closed.has(part.toolCallId) && !keepOpen.has(part.toolCallId)) {
        unsafeIds.push(part.toolCallId);
      }
    }
  }
  if (unsafeIds.length > 0) {
    closeOpenToolWave(store, sessionId, 'interrupted', { onlyToolCallIds: unsafeIds });
  }
}

function isRunEligibleForAutoResume(
  host: DurableSchedulerHost,
  run: DurableRunRecord,
  restartLimit: number
): boolean {
  if (run.restarts >= restartLimit) {
    host.store.durableJournal.updateRun(run.runId, {
      status: 'failed',
      errorText: `restart_limit (${run.restarts}/${restartLimit})`,
    });
    return false;
  }
  if (host.isSessionRunning?.(run.sessionId)) return false;
  if (host.store.isSessionWriterLive(run.sessionId)) return false;
  const session = host.store.getSession(run.sessionId);
  if (!session) return false;
  if (session.status === 'waiting_approval' || session.status === 'completed') return false;
  return true;
}

/**
 * Scheduler tick: auto-resume eligible crashed runs when mode !== 'off' and
 * chatRestartPolicy === 'auto_resume'.
 */
export async function tickDurableRecovery(host: DurableSchedulerHost): Promise<number> {
  const settings = readDurableSettings(host.store);
  if (settings.mode === 'off' || settings.chatRestartPolicy !== 'auto_resume') return 0;
  const candidates = host.store.durableJournal.listRunsByStatus(['resumable']);
  let resumed = 0;
  for (const run of candidates) {
    if (!isRunEligibleForAutoResume(host, run, settings.restartLimit)) continue;
    resumed += 1;
    try {
      await host.runSession(run.sessionId);
    } catch (error) {
      host.log?.warn('durable auto-resume failed', {
        sessionId: run.sessionId,
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return resumed;
}

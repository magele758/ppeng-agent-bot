/**
 * Core Durable Control Plane boot recovery and scheduler auto-resume.
 * Phase 3 adds crash-safe `rolling_back` Saga resume, `waiting_park` signal /
 * deadline wakeup, and automatic `reconcile()` convergence before resume.
 * Every helper kept small (CC <= 5) for CRAP gate compliance.
 */

import {
  readDurableSettings,
  reconcileUnknownStepsForRun,
  runDurableSagaRollback,
  wakeReadyParkedRun,
  type CompensationSpec,
  type DurableRunRecord,
  type DurableStepRecord,
  type ToolContract,
} from '@ppeng/agent-loop';
import type { SqliteStateStore } from '../storage.js';
import { closeOpenToolWave } from '../session/tool-wave-close.js';
import type { SessionRecord } from '../types.js';
import { buildSyntheticStepContext } from './rollback-service.js';
import type { CompositeWorkspaceTxManager } from './workspace-tx-manager.js';

export interface DurableSchedulerHost {
  store: SqliteStateStore;
  runSession(sessionId: string): Promise<SessionRecord>;
  isSessionRunning?(sessionId: string): boolean;
  tools?: readonly ToolContract<any>[];
  workspaceTx?: CompositeWorkspaceTxManager;
  repoRoot?: string;
  stateDir?: string;
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
 * Leaves `rolling_back` and `waiting_park` runs untouched so the scheduler
 * finishes interrupted compensations and resumes parked signals cleanly.
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
 * Mark active/resumable durable runs for a session as aborted so the
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
  const keepOpen = collectResumableToolCallIds(store.durableJournal.listSteps(latest.runId));
  if (keepOpen.size === 0) {
    closeOpenToolWave(store, sessionId, 'interrupted');
    return;
  }
  const unsafeIds = findUnmatchedUnsafeIds(store.foldMessages(sessionId), keepOpen);
  if (unsafeIds.length > 0) {
    closeOpenToolWave(store, sessionId, 'interrupted', { onlyToolCallIds: unsafeIds });
  }
}

function collectResumableToolCallIds(steps: readonly DurableStepRecord[]): Set<string> {
  const keep = new Set<string>();
  for (const step of steps) {
    if (!step.toolCallId) continue;
    if (step.phase === 'planned') keep.add(step.toolCallId);
    if (step.phase === 'unknown' && step.replayPolicy === 'safe') keep.add(step.toolCallId);
  }
  return keep;
}

function findUnmatchedUnsafeIds(
  folded: readonly { parts: readonly { type: string; toolCallId?: string }[] }[],
  keepOpen: ReadonlySet<string>
): string[] {
  const closed = new Set<string>();
  const unsafeIds: string[] = [];
  for (const msg of folded) {
    for (const part of msg.parts) {
      if (part.type === 'tool_result' && part.toolCallId) closed.add(part.toolCallId);
    }
  }
  for (const msg of folded) {
    for (const part of msg.parts) {
      if (part.type === 'tool_call' && part.toolCallId && !closed.has(part.toolCallId) && !keepOpen.has(part.toolCallId)) {
        unsafeIds.push(part.toolCallId);
      }
    }
  }
  return unsafeIds;
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

async function resumeInterruptedRollbacks(host: DurableSchedulerHost): Promise<number> {
  const rolling = host.store.durableJournal.listRunsByStatus(['rolling_back']);
  const byName = new Map((host.tools ?? []).map((t) => [t.name, t]));
  let finished = 0;
  for (const run of rolling) {
    const res = await runDurableSagaRollback({
      journal: host.store.durableJournal,
      runId: run.runId,
      force: true,
      executeCompensation: async (spec: CompensationSpec, step: DurableStepRecord) => {
        const tool = byName.get(spec.toolName);
        if (!tool?.executeCompensation) return { ok: false, error: `Missing compensator for ${spec.toolName}` };
        const ctx = buildSyntheticStepContext({
          store: host.store,
          sessionId: run.sessionId,
          repoRoot: host.repoRoot ?? process.cwd(),
          stateDir: host.stateDir ?? '',
          step,
        });
        return tool.executeCompensation(ctx, spec);
      },
      rollbackWorkspace: async () => {
        const scope = run.txScopeId ? host.workspaceTx?.loadScope(run.txScopeId) : undefined;
        if (!scope || !host.workspaceTx) return { ok: true, conflictsCount: 0 };
        const wb = await host.workspaceTx.rollbackTo(scope.scopeId, scope.baseline);
        return { ok: wb.ok, conflictsCount: wb.conflicts.length };
      },
    });
    if (res.ok || res.runStatus === 'needs_reconcile') finished += 1;
  }
  return finished;
}

function wakeDueParkedRuns(host: DurableSchedulerHost, nowMs = Date.now()): number {
  const parked = host.store.durableJournal.listRunsByStatus(['waiting_park']);
  let wokeCount = 0;
  for (const run of parked) {
    const res = wakeReadyParkedRun(host.store.durableJournal, run.runId, nowMs);
    if (res.woke) wokeCount += 1;
  }
  return wokeCount;
}

async function maybeReconcileUnknownSteps(host: DurableSchedulerHost, run: DurableRunRecord): Promise<boolean> {
  if (!host.tools?.length) return true;
  const steps = host.store.durableJournal.listSteps(run.runId);
  const hasReconcilable = steps.some((s) => s.phase === 'unknown' && host.tools!.some((t) => t.name === s.toolName && t.reconcile));
  if (!hasReconcilable) return true;
  const outcome = await reconcileUnknownStepsForRun({
    journal: host.store.durableJournal,
    runId: run.runId,
    tools: host.tools,
    buildContext: (step) =>
      buildSyntheticStepContext({
        store: host.store,
        sessionId: run.sessionId,
        repoRoot: host.repoRoot ?? process.cwd(),
        stateDir: host.stateDir ?? '',
        step,
      }),
  });
  return outcome.unresolvedStepIds.length === 0;
}

/**
 * Scheduler tick:
 * 1. Finish any crash-interrupted `rolling_back` Sagas (highest priority).
 * 2. Wake any `waiting_park` runs whose signal arrived or deadline elapsed.
 * 3. Reconcile `unknown` steps with tool probes and auto-resume eligible runs.
 */
export async function tickDurableRecovery(host: DurableSchedulerHost): Promise<number> {
  const settings = readDurableSettings(host.store);
  if (settings.mode === 'off') return 0;

  let acted = await resumeInterruptedRollbacks(host);
  wakeDueParkedRuns(host);

  if (settings.chatRestartPolicy !== 'auto_resume') return acted;
  const candidates = host.store.durableJournal.listRunsByStatus(['resumable']);
  for (const run of candidates) {
    if (!isRunEligibleForAutoResume(host, run, settings.restartLimit)) continue;
    const ready = await maybeReconcileUnknownSteps(host, run);
    if (!ready) continue;
    acted += 1;
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
  return acted;
}

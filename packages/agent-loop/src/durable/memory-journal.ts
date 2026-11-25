/**
 * In-memory DurableJournalPort — zero Node I/O, safe for `mini` & tests.
 */

import { createId, nowIso } from '../helpers.js';
import { createInitialDurableKernelState, normalizeDurableKernelState } from './step-helpers.js';
import type {
  CommitDurableStepPatch,
  DurableJournalPort,
  DurableRunRecord,
  DurableRunStatus,
  DurableSignalRecord,
  DurableStepPhase,
  DurableStepRecord,
  PlanDurableStepInput,
  ToolParkDirective,
  UpdateDurableRunPatch,
} from './types.js';

function cloneRun(run: DurableRunRecord): DurableRunRecord {
  return {
    ...run,
    kernelState: {
      ...run.kernelState,
      pendingAdvisories: [...run.kernelState.pendingAdvisories],
    },
  };
}

function cloneStep(step: DurableStepRecord): DurableStepRecord {
  return {
    ...step,
    ...(step.receipt ? { receipt: { ...step.receipt } } : {}),
    ...(step.compensationSpec
      ? { compensationSpec: { ...step.compensationSpec, payload: { ...step.compensationSpec.payload } } }
      : {}),
    ...(step.park ? { park: { ...step.park } } : {}),
  };
}

export class MemoryDurableJournal implements DurableJournalPort {
  private readonly runs = new Map<string, DurableRunRecord>();
  private readonly runOrder: string[] = [];
  private readonly steps = new Map<string, DurableStepRecord>();
  private readonly stepsByRun = new Map<string, string[]>();
  private readonly stepByToolCall = new Map<string, string>();
  private readonly memos = new Map<string, unknown>();
  private readonly signals = new Map<string, DurableSignalRecord>();

  private requireRun(runId: string): DurableRunRecord {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`Durable run not found: ${runId}`);
    return existing;
  }

  private requireStep(stepId: string): DurableStepRecord {
    const existing = this.steps.get(stepId);
    if (!existing) throw new Error(`Durable step not found: ${stepId}`);
    return existing;
  }

  beginRun(input: {
    runId: string;
    sessionId: string;
    parentRunId?: string;
    txScopeId?: string;
    kernelState?: DurableRunRecord['kernelState'];
  }): DurableRunRecord {
    const existing = this.runs.get(input.runId);
    if (existing) return cloneRun(existing);
    const prev = this.getLatestRunForSession(input.sessionId);
    const now = nowIso();
    const record: DurableRunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      fencingEpoch: (prev?.fencingEpoch ?? 0) + 1,
      status: 'running',
      ...(input.txScopeId ? { txScopeId: input.txScopeId } : {}),
      passedPivot: false,
      restarts: 0,
      kernelState: input.kernelState ? normalizeDurableKernelState(input.kernelState) : createInitialDurableKernelState(),
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(record.runId, record);
    this.runOrder.push(record.runId);
    this.stepsByRun.set(record.runId, []);
    return cloneRun(record);
  }

  getRun(runId: string): DurableRunRecord | undefined {
    const found = this.runs.get(runId);
    return found ? cloneRun(found) : undefined;
  }

  getLatestRunForSession(sessionId: string): DurableRunRecord | undefined {
    for (let i = this.runOrder.length - 1; i >= 0; i--) {
      const run = this.runs.get(this.runOrder[i]!);
      if (run?.sessionId === sessionId) return cloneRun(run);
    }
    return undefined;
  }

  listRunsForSession(sessionId: string, limit = 20): DurableRunRecord[] {
    const out: DurableRunRecord[] = [];
    for (let i = this.runOrder.length - 1; i >= 0 && out.length < limit; i--) {
      const run = this.runs.get(this.runOrder[i]!);
      if (run?.sessionId === sessionId) out.push(cloneRun(run));
    }
    return out;
  }

  listRunsByStatus(statuses: readonly DurableRunStatus[]): DurableRunRecord[] {
    const allowed = new Set(statuses);
    const out: DurableRunRecord[] = [];
    for (const id of this.runOrder) {
      const run = this.runs.get(id);
      if (run && allowed.has(run.status)) out.push(cloneRun(run));
    }
    return out;
  }

  listChildRuns(parentRunId: string): DurableRunRecord[] {
    const out: DurableRunRecord[] = [];
    for (const id of this.runOrder) {
      const run = this.runs.get(id);
      if (run?.parentRunId === parentRunId) out.push(cloneRun(run));
    }
    return out;
  }

  updateRun(runId: string, patch: UpdateDurableRunPatch): DurableRunRecord {
    const current = this.requireRun(runId);
    const next: DurableRunRecord = {
      ...current,
      ...patch,
      kernelState: patch.kernelState ? normalizeDurableKernelState(patch.kernelState) : current.kernelState,
      updatedAt: nowIso(),
    };
    this.runs.set(runId, next);
    return cloneRun(next);
  }

  planStep(input: PlanDurableStepInput): DurableStepRecord {
    if (input.toolCallId) {
      const existingId = this.stepByToolCall.get(`${input.runId}\0${input.turn}\0${input.toolCallId}`);
      if (existingId) return cloneStep(this.requireStep(existingId));
    }
    const stepId = input.stepId ?? createId('dstep');
    const record: DurableStepRecord = {
      stepId,
      runId: input.runId,
      sessionId: input.sessionId,
      turn: input.turn,
      waveIndex: input.waveIndex,
      fencingEpoch: input.fencingEpoch ?? 1,
      kind: input.kind,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      idempotencyKey: input.idempotencyKey,
      effectClass: input.effectClass,
      replayPolicy: input.replayPolicy,
      phase: 'planned',
      ...(input.argsHash ? { argsHash: input.argsHash } : {}),
      ...(input.snapshotRef ? { snapshotRef: input.snapshotRef } : {}),
      createdAt: nowIso(),
    };
    this.steps.set(stepId, record);
    const list = this.stepsByRun.get(input.runId) ?? [];
    list.push(stepId);
    this.stepsByRun.set(input.runId, list);
    if (input.toolCallId) {
      this.stepByToolCall.set(`${input.runId}\0${input.turn}\0${input.toolCallId}`, stepId);
      this.stepByToolCall.set(`${input.runId}\0${input.toolCallId}`, stepId);
    }
    return cloneStep(record);
  }

  getStep(stepId: string): DurableStepRecord | undefined {
    const found = this.steps.get(stepId);
    return found ? cloneStep(found) : undefined;
  }

  getStepByToolCall(runId: string, toolCallId: string, turn?: number): DurableStepRecord | undefined {
    const key = turn !== undefined ? `${runId}\0${turn}\0${toolCallId}` : `${runId}\0${toolCallId}`;
    const id = this.stepByToolCall.get(key);
    return id ? this.getStep(id) : undefined;
  }

  listSteps(runId: string): DurableStepRecord[] {
    const ids = this.stepsByRun.get(runId) ?? [];
    return ids.map((id) => cloneStep(this.requireStep(id)));
  }

  markStepDispatched(stepId: string, opts?: { snapshotRef?: string; startedAt?: string }): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = {
      ...current,
      phase: 'dispatched',
      startedAt: opts?.startedAt ?? nowIso(),
      ...(opts?.snapshotRef !== undefined ? { snapshotRef: opts.snapshotRef } : {}),
    };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  commitStep(stepId: string, patch?: CommitDurableStepPatch): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = {
      ...current,
      phase: 'committed',
      finishedAt: patch?.finishedAt ?? nowIso(),
      ...(patch?.messageSeq !== undefined ? { messageSeq: patch.messageSeq } : {}),
      ...(patch?.snapshotRef !== undefined ? { snapshotRef: patch.snapshotRef } : {}),
      ...(patch?.receipt !== undefined ? { receipt: patch.receipt } : {}),
      ...(patch?.compensationSpec !== undefined ? { compensationSpec: patch.compensationSpec } : {}),
    };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  failStep(stepId: string, errorText: string, patch?: { messageSeq?: number }): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = {
      ...current,
      phase: 'failed',
      errorText,
      finishedAt: nowIso(),
      ...(patch?.messageSeq !== undefined ? { messageSeq: patch.messageSeq } : {}),
    };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  markStepUnknown(stepId: string, reason: string): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = { ...current, phase: 'unknown', errorText: reason };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  parkStep(stepId: string, park: ToolParkDirective): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = { ...current, phase: 'parked', park };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  updateStepPhase(
    stepId: string,
    phase: DurableStepPhase,
    patch?: { errorText?: string; receipt?: Record<string, unknown>; snapshotRef?: string }
  ): DurableStepRecord {
    const current = this.requireStep(stepId);
    const next: DurableStepRecord = {
      ...current,
      phase,
      ...(patch?.errorText !== undefined ? { errorText: patch.errorText } : {}),
      ...(patch?.receipt !== undefined ? { receipt: patch.receipt } : {}),
      ...(patch?.snapshotRef !== undefined ? { snapshotRef: patch.snapshotRef } : {}),
    };
    this.steps.set(stepId, next);
    return cloneStep(next);
  }

  memo<T>(stepId: string, key: string, value: T): T {
    const composite = `${stepId}\0${key}`;
    if (this.memos.has(composite)) return this.memos.get(composite) as T;
    this.memos.set(composite, value);
    return value;
  }

  getMemo<T = unknown>(stepId: string, key: string): T | undefined {
    const composite = `${stepId}\0${key}`;
    return this.memos.has(composite) ? (this.memos.get(composite) as T) : undefined;
  }

  deliverSignal(input: {
    runId: string;
    stepId: string;
    signalName: string;
    signalKey: string;
    payload: unknown;
  }): { status: 'delivered' | 'duplicate' | 'closed' } {
    const run = this.runs.get(input.runId);
    if (!run || ['completed', 'failed', 'aborted', 'rolled_back'].includes(run.status)) {
      return { status: 'closed' };
    }
    const composite = `${input.runId}\0${input.stepId}\0${input.signalName}\0${input.signalKey}`;
    const existing = this.signals.get(composite);
    if (existing) {
      return { status: existing.state === 'expired' ? 'closed' : 'duplicate' };
    }
    const now = nowIso();
    this.signals.set(composite, {
      runId: input.runId,
      stepId: input.stepId,
      signalName: input.signalName,
      signalKey: input.signalKey,
      state: 'pending',
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
    });
    return { status: 'delivered' };
  }

  readSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined {
    const found = this.signals.get(`${runId}\0${stepId}\0${signalName}\0${signalKey}`);
    return found ? { ...found } : undefined;
  }

  listSignals(runId: string): DurableSignalRecord[] {
    const out: DurableSignalRecord[] = [];
    for (const rec of this.signals.values()) {
      if (rec.runId === runId) out.push({ ...rec });
    }
    return out;
  }

  consumeSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined {
    const composite = `${runId}\0${stepId}\0${signalName}\0${signalKey}`;
    const found = this.signals.get(composite);
    if (!found || found.state !== 'pending') return undefined;
    const next: DurableSignalRecord = { ...found, state: 'consumed', updatedAt: nowIso() };
    this.signals.set(composite, next);
    return { ...next };
  }

  expireSignals(runId: string, stepId: string): number {
    let count = 0;
    const prefix = `${runId}\0${stepId}\0`;
    const now = nowIso();
    for (const [k, rec] of this.signals.entries()) {
      if (!k.startsWith(prefix) || rec.state !== 'pending') continue;
      this.signals.set(k, { ...rec, state: 'expired', updatedAt: now });
      count += 1;
    }
    return count;
  }
}

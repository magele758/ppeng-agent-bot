/**
 * Explicit-on sessions enter the handoff machine at turn start.
 * Auto-policy task sessions do the same on a user turn while session budget remains.
 * Chat auto stays out until a controlled tool enters planner_readonly.
 */
import type { ToolExecResult, TurnKernelHost } from '../turn/host.js';
import { trajectoryHandoffGateFromMetadata } from '../runtime/run-profile.js';
import { acceptedPlanVersion, type HandoffContextPack } from './plan-commit.js';
import { parseCapabilityTiers } from './config.js';
import { applyTransition, checkHandoffCap, createInitialKernelState, isTerminal } from './state-machine.js';
import { prepareTrajectoryToolWave, trajectoryWritesPending } from './tool-entry.js';
import {
  DEFAULT_SESSION_CAP,
  DEFAULT_TURN_CAP,
  type HandoffKernelState,
  type HandoffState,
  type PlanObject,
  type PlanStatus,
} from './types.js';

type JsonMap = { [key: string]: unknown };
type HostSlice = {
  store: TurnKernelHost['store'];
  mergeSessionMetadata: TurnKernelHost['mergeSessionMetadata'];
};

const PLANNER_STATE: { [key: string]: true } = { planner_readonly: true, planner_repair: true };
const EXECUTOR_STATE: { [key: string]: true } = { executor_write: true };
const KNOWN_STATE: { [key: string]: true } = {
  planner_readonly: true,
  plan_ready: true,
  executor_write: true,
  planner_repair: true,
  awaiting_coordinator: true,
  answered: true,
  done: true,
  capped: true,
  failed: true,
  cancelled: true,
  timed_out: true,
};
const PLAN_STATUS: { [key: string]: true } = {
  draft: true,
  accepted: true,
  superseded: true,
  failed: true,
};

function asRecord(value: unknown): JsonMap | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonMap;
}

function roleFor(state: string): 'planner' | 'executor' | undefined {
  if (state in PLANNER_STATE) return 'planner';
  if (state in EXECUTOR_STATE) return 'executor';
  return undefined;
}

function readPlan(value: unknown): PlanObject | null {
  const record = asRecord(value);
  if (!record || typeof record.version !== 'number' || !Array.isArray(record.steps)) return null;
  if (typeof record.planId !== 'string' || !record.planId) return null;
  const steps: PlanObject['steps'][number][] = [];
  for (const step of record.steps) {
    const item = asRecord(step);
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    steps.push({
      id: item.id,
      description: typeof item.description === 'string' ? item.description : item.id,
    });
  }
  const status = typeof record.status === 'string' && record.status in PLAN_STATUS
    ? record.status as PlanStatus
    : 'accepted';
  return {
    planId: record.planId,
    version: record.version,
    status,
    steps,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
  };
}

function readKernel(metadata: JsonMap | undefined): HandoffKernelState | undefined {
  const raw = asRecord(metadata?.handoffKernel);
  if (!raw || typeof raw.state !== 'string' || !Object.prototype.hasOwnProperty.call(KNOWN_STATE, raw.state)) {
    return undefined;
  }
  const counters = asRecord(raw.counters);
  return {
    state: raw.state as HandoffState,
    plan: readPlan(raw.plan),
    counters: {
      sessionHandoffs: typeof counters?.sessionHandoffs === 'number' ? counters.sessionHandoffs : 0,
      turnHandoffs: typeof counters?.turnHandoffs === 'number' ? counters.turnHandoffs : 0,
    },
    enteredAt: typeof raw.enteredAt === 'string' ? raw.enteredAt : new Date(0).toISOString(),
    turnNumber: typeof raw.turnNumber === 'number' ? raw.turnNumber : 1,
  };
}

function modelRef(metadata: JsonMap | undefined, role: 'planner' | 'executor'): string {
  const roles = asRecord(asRecord(metadata?.capabilityTiers)?.roles);
  const named = roles?.[role === 'planner' ? 'plannerModel' : 'executorModel'];
  if (typeof named === 'string' && named.trim()) return named.trim();
  const pinned = metadata?.pinnedSessionModel ?? metadata?.modelRef;
  return typeof pinned === 'string' && pinned.trim() ? pinned.trim() : 'session';
}

function capsOf(metadata: JsonMap | undefined): { session: number; turn: number } {
  const parsed = parseCapabilityTiers(metadata?.capabilityTiers);
  if (!parsed.ok) return { session: DEFAULT_SESSION_CAP, turn: DEFAULT_TURN_CAP };
  return { session: parsed.resolved.perSessionCap, turn: parsed.resolved.perTurnCap };
}

function sessionHandoffsOf(metadata: JsonMap | undefined): number {
  const kernel = readKernel(metadata);
  if (kernel) return kernel.counters.sessionHandoffs;
  const raw = metadata?.handoffSessionCount;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

interface EffectRow {
  stepId: string;
  dedupeId: string;
  attemptId: string;
}

function effectRows(value: unknown): EffectRow[] {
  if (!Array.isArray(value)) return [];
  const rows: EffectRow[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record.stepId !== 'string' || typeof record.dedupeId !== 'string' || typeof record.attemptId !== 'string') {
      continue;
    }
    rows.push({ stepId: record.stepId, dedupeId: record.dedupeId, attemptId: record.attemptId });
  }
  return rows;
}

function dedupeEffects(rows: readonly EffectRow[]): EffectRow[] {
  const seen = new Set();
  const out: EffectRow[] = [];
  for (const row of rows) {
    const key = row.stepId + '\0' + row.dedupeId + '\0' + row.attemptId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function ledger(
  metadata: JsonMap | undefined,
  results: readonly ToolExecResult[],
  planValue: unknown,
): EffectRow[] {
  return dedupeEffects([
    ...effectRows(metadata?.completedEffects),
    ...results.flatMap((result) => effectRows(result.metadata?.completedEffects)),
    ...effectRows(asRecord(planValue)?.appliedEffects),
  ]);
}

function packPlan(value: unknown): HandoffContextPack['plan'] | undefined {
  const record = asRecord(value);
  if (!record || typeof record.version !== 'number' || !Array.isArray(record.steps)) return undefined;
  const steps = record.steps.flatMap((step, index) => {
    const item = asRecord(step);
    if (!item) return [];
    const id = typeof item.id === 'string' && item.id
      ? item.id
      : typeof item.title === 'string' && item.title
        ? item.title
        : String(index + 1);
    const description = typeof item.description === 'string'
      ? item.description
      : typeof item.title === 'string'
        ? item.title
        : id;
    return [{
      id,
      description,
      ...(typeof item.status === 'string' ? { status: item.status } : {}),
    }];
  });
  return {
    version: record.version,
    steps,
    ...(typeof record.analysis === 'string' ? { analysis: record.analysis } : {}),
  };
}

function asPlanObject(snapshot: HandoffContextPack['plan'] | undefined, previous: PlanObject | null): PlanObject | null {
  if (!snapshot) return previous;
  return {
    planId: previous?.planId ?? 'plan',
    version: snapshot.version,
    status: 'accepted',
    steps: snapshot.steps.map((step) => ({ id: step.id, description: step.description })),
    createdAt: previous?.createdAt ?? new Date(0).toISOString(),
  };
}

function frictionOf(result: ToolExecResult): { stepId: string; evidence: string } | undefined {
  const raw = asRecord(result.metadata?.handoffFriction);
  if (!raw || raw.kind !== 'step_failed') return undefined;
  const evidence = typeof raw.evidence === 'string' && raw.evidence
    ? raw.evidence
    : typeof result.metadata?.failureEvidence === 'string'
      ? result.metadata.failureEvidence
      : result.content;
  return {
    stepId: typeof raw.stepId === 'string' && raw.stepId ? raw.stepId : result.toolCallId,
    evidence,
  };
}

function buildPack(
  metadata: JsonMap | undefined,
  results: readonly ToolExecResult[],
  planVersion: number,
  fromRole: 'planner' | 'executor',
  toRole: 'planner' | 'executor',
  effects: EffectRow[],
  plan: HandoffContextPack['plan'] | undefined,
  failure?: { stepId: string; evidence: string },
): HandoffContextPack {
  return {
    planVersion,
    fromRole,
    toRole,
    fromModel: modelRef(metadata, fromRole),
    toModel: modelRef(metadata, toRole),
    toolPairs: results.map((result) => ({
      callId: result.toolCallId,
      name: result.name,
      ok: result.ok,
      result: result.content,
    })),
    completedEffects: effects,
    ...(plan ? { plan } : {}),
    ...(failure ? { failureEvidence: failure } : {}),
  };
}

function countersPatch(kernel: HandoffKernelState): JsonMap {
  return {
    handoffKernel: kernel,
    handoffState: kernel.state,
    handoffSessionCount: kernel.counters.sessionHandoffs,
    handoffTurnCount: kernel.counters.turnHandoffs,
  };
}

function cappedPatch(kernel: HandoffKernelState, reason: 'session_cap' | 'turn_cap'): JsonMap {
  return {
    ...countersPatch(kernel),
    handoffCapReason: reason,
  };
}

function activePatch(
  kernel: HandoffKernelState,
  pack: HandoffContextPack,
  effects: EffectRow[],
): JsonMap {
  const role = roleFor(kernel.state);
  return {
    ...countersPatch(kernel),
    ...(role ? { handoffRole: role } : {}),
    handoffContext: pack,
    completedEffects: effects,
    handoffBlocked: undefined,
    handoffCapReason: undefined,
  };
}

function exceed(
  kernel: HandoffKernelState,
  now: string,
  caps: { session: number; turn: number },
): { capped: true; patch: JsonMap } | { capped: false } {
  const decision = checkHandoffCap(kernel.counters, caps.session, caps.turn);
  if (decision.allowed) return { capped: false };
  const next = applyTransition(kernel, 'cap_exceeded', now);
  if (!next.ok) return { capped: false };
  return { capped: true, patch: cappedPatch(next.next, decision.reason ?? 'turn_cap') };
}

/** Model-visible handoff pack. Absent when this session has no pack yet. */
export function handoffContextMessage(metadata: unknown): string | undefined {
  const pack = asRecord(asRecord(metadata)?.handoffContext);
  if (!pack) return undefined;
  return '[handoff-context]\n' + JSON.stringify(pack);
}

/** Planner text with no tool call closes the occupancy so later iterations stay terminal. */
export function closePlannerDirectAnswer(
  metadata: unknown,
  assistantText: string,
): JsonMap | undefined {
  if (!assistantText.trim()) return undefined;
  const record = asRecord(metadata);
  if (!trajectoryHandoffGateFromMetadata(record).enabled) return undefined;
  const kernel = readKernel(record);
  if (!kernel || kernel.state !== 'planner_readonly') return undefined;
  const answered = applyTransition(kernel, 'direct_answer', new Date().toISOString());
  if (!answered.ok) return undefined;
  return countersPatch(answered.next);
}

/** Enter planner_readonly for auto policy. Preserves the session handoff count. */
export async function enterAutoPlannerReadonly(
  host: HostSlice,
  sessionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = host.store.getSession(sessionId);
  if (!session) return { ok: false, reason: 'session missing' };
  const metadata = asRecord(session.metadata);
  if (metadata?.handoffSuspended === 'session_cap') {
    return { ok: false, reason: 'session handoff cap exhausted' };
  }
  const prepared = await prepareTrajectoryToolWave({
    id: sessionId,
    metadata: { ...(metadata ?? {}), handoffState: 'planner_readonly', handoffEntering: 'planner_readonly' },
  });
  if (!prepared.ok) return prepared;
  const initial = createInitialKernelState({ now: new Date().toISOString(), turnNumber: 1 });
  const kernel: HandoffKernelState = {
    ...initial,
    counters: { sessionHandoffs: sessionHandoffsOf(metadata), turnHandoffs: 0 },
  };
  const parsed = parseCapabilityTiers(metadata?.capabilityTiers);
  host.mergeSessionMetadata(sessionId, {
    ...countersPatch(kernel),
    handoffRole: 'planner',
    handoffWorkTurn: true,
    ...(!parsed.ok ? { handoffTierWarning: parsed.warning } : {}),
  });
  return { ok: true };
}

/** Enter or resume the occupancy and stamp handoffRole before the model call. */
export async function prepareExplicitSessionHandoff(
  host: HostSlice,
  sessionId: string,
  options?: { userTurn?: boolean },
): Promise<void> {
  const session = host.store.getSession(sessionId);
  if (!session) return;
  const metadata = asRecord(session.metadata);
  if (metadata?.handoffSuspended === 'session_cap') return;
  const gate = trajectoryHandoffGateFromMetadata(metadata);
  if (gate.path === 'auto_eligible') {
    const remaining = capsOf(metadata).session - sessionHandoffsOf(metadata);
    if (session.mode === 'task' && options?.userTurn === true && remaining > 0) {
      await enterAutoPlannerReadonly(host, sessionId);
    }
    return;
  }
  if (gate.path !== 'in_machine') return;
  const now = new Date().toISOString();
  let kernel = readKernel(metadata);
  if (kernel && isTerminal(kernel.state)) {
    if (!options?.userTurn) {
      host.mergeSessionMetadata(sessionId, countersPatch(kernel));
      return;
    }
    const caps = capsOf(metadata);
    const sessionExhausted = kernel.counters.sessionHandoffs >= caps.session
      || metadata?.handoffCapReason === 'session_cap';
    if (sessionExhausted) {
      host.mergeSessionMetadata(sessionId, { handoffSuspended: 'session_cap' });
      return;
    }
    const prepared = await prepareTrajectoryToolWave({
      id: sessionId,
      metadata: { ...metadata, handoffState: 'planner_readonly', handoffEntering: 'planner_readonly' },
    });
    if (!prepared.ok) return;
    kernel = {
      state: 'planner_readonly',
      plan: null,
      counters: { sessionHandoffs: kernel.counters.sessionHandoffs, turnHandoffs: 0 },
      enteredAt: now,
      turnNumber: kernel.turnNumber + 1,
    };
    host.mergeSessionMetadata(sessionId, {
      ...countersPatch(kernel),
      handoffRole: 'planner',
      handoffContext: undefined,
      handoffBlocked: undefined,
      handoffCapReason: undefined,
    });
    return;
  }
  if (!kernel) {
    const prepared = await prepareTrajectoryToolWave({
      id: sessionId,
      metadata: { ...metadata, handoffState: 'planner_readonly', handoffEntering: 'planner_readonly' },
    });
    if (!prepared.ok) return;
    kernel = createInitialKernelState({ now, turnNumber: 1 });
  }
  const role = roleFor(kernel.state);
  host.mergeSessionMetadata(sessionId, {
    ...countersPatch(kernel),
    ...(role ? { handoffRole: role } : {}),
  });
}

/**
 * Publish moves planner_readonly to plan_ready to executor_write, or
 * planner_repair to executor_write. Host friction moves executor_write to
 * planner_repair. Each counted edge checks the configured caps first.
 */
export function advanceExplicitHandoffAfterTools(
  metadata: JsonMap | undefined,
  results: readonly ToolExecResult[],
  sessionId?: string,
): JsonMap | undefined {
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return undefined;
  const current = readKernel(metadata);
  if (!current) return undefined;
  const accepted = results.find((result) => result.ok && result.metadata?.handoffPlanAccepted === true);
  const frictionResult = results.find((result) => result.ok && frictionOf(result));
  if (!accepted && !frictionResult) return undefined;
  const now = new Date().toISOString();
  const caps = capsOf(metadata);
  const planValue = accepted?.metadata?.plan ?? frictionResult?.metadata?.plan;
  const snapshot = packPlan(planValue);
  const effects = ledger(metadata, results, planValue);
  let kernel: HandoffKernelState = snapshot
    ? { ...current, plan: asPlanObject(snapshot, current.plan) }
    : current;
  const versionRaw = accepted?.metadata?.planVersion ?? frictionResult?.metadata?.planVersion;
  const planVersion = typeof versionRaw === 'number' && versionRaw > 0
    ? Math.floor(versionRaw)
    : snapshot && snapshot.version > 0
      ? snapshot.version
      : acceptedPlanVersion(kernel.plan) || 1;

  if (accepted && (kernel.state === 'planner_readonly' || kernel.state === 'planner_repair')) {
    if (kernel.state === 'planner_readonly') {
      const submitted = applyTransition(kernel, 'submit_plan', now);
      if (!submitted.ok) return undefined;
      kernel = submitted.next;
    }
    const gate = exceed(kernel, now, caps);
    if (gate.capped) return gate.patch;
    const activated = applyTransition(kernel, 'activate_executor', now);
    if (!activated.ok) return undefined;
    return activePatch(
      activated.next,
      buildPack(metadata, results, planVersion, 'planner', 'executor', effects, snapshot),
      effects,
    );
  }

  if (frictionResult && kernel.state === 'executor_write') {
    if (sessionId && trajectoryWritesPending(sessionId)) {
      return {
        ...countersPatch(kernel),
        handoffRole: 'executor',
        handoffBlocked: 'pending_writes',
      };
    }
    const gate = exceed(kernel, now, caps);
    if (gate.capped) return gate.patch;
    const friction = frictionOf(frictionResult)!;
    const repaired = applyTransition(kernel, 'friction', now);
    if (!repaired.ok) return undefined;
    return activePatch(
      repaired.next,
      buildPack(metadata, results, planVersion, 'executor', 'planner', effects, snapshot, friction),
      effects,
    );
  }

  return undefined;
}
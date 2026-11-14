/**
 * Explicit-on session handoff on the turn kernel path.
 * Enters the state machine, stamps handoffRole before the model call, and
 * carries one context pack across plan_ready → executor_write on the same session.
 * Missing tiers and explicit close stay off.
 */

import type { ToolExecResult, TurnKernelHost } from '../turn/host.js';
import { trajectoryHandoffGateFromMetadata } from '../runtime/run-profile.js';
import type { HandoffContextPack } from './plan-commit.js';
import { applyTransition, createInitialKernelState } from './state-machine.js';
import { prepareTrajectoryToolWave } from './tool-entry.js';
import type { HandoffKernelState, HandoffState } from './types.js';

const PLANNER_STATE: Record<string, true> = {
  planner_readonly: true,
  plan_ready: true,
  planner_repair: true,
};
const EXECUTOR_STATE: Record<string, true> = { executor_write: true };
const KNOWN_STATE: Record<HandoffState, true> = {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function roleFor(state: string): 'planner' | 'executor' | undefined {
  if (state in PLANNER_STATE) return 'planner';
  if (state in EXECUTOR_STATE) return 'executor';
  return undefined;
}

function readKernel(metadata: Record<string, unknown> | undefined): HandoffKernelState | undefined {
  const raw = asRecord(metadata?.handoffKernel);
  if (!raw || typeof raw.state !== 'string' || !Object.prototype.hasOwnProperty.call(KNOWN_STATE, raw.state)) {
    return undefined;
  }
  const counters = asRecord(raw.counters);
  return {
    state: raw.state as HandoffState,
    plan: null,
    counters: {
      sessionHandoffs: typeof counters?.sessionHandoffs === 'number' ? counters.sessionHandoffs : 0,
      turnHandoffs: typeof counters?.turnHandoffs === 'number' ? counters.turnHandoffs : 0,
    },
    enteredAt: typeof raw.enteredAt === 'string' ? raw.enteredAt : new Date(0).toISOString(),
    turnNumber: typeof raw.turnNumber === 'number' ? raw.turnNumber : 1,
  };
}

function modelRef(metadata: Record<string, unknown> | undefined, role: 'planner' | 'executor'): string {
  const roles = asRecord(asRecord(metadata?.capabilityTiers)?.roles);
  const named = roles?.[role === 'planner' ? 'plannerModel' : 'executorModel'];
  if (typeof named === 'string' && named.trim()) return named.trim();
  const pinned = metadata?.pinnedSessionModel ?? metadata?.modelRef;
  return typeof pinned === 'string' && pinned.trim() ? pinned.trim() : 'session';
}

function packFrom(
  metadata: Record<string, unknown> | undefined,
  results: readonly ToolExecResult[],
  planVersion: number,
): HandoffContextPack {
  const failed = results.find((result) => !result.ok);
  return {
    planVersion,
    fromRole: 'planner',
    toRole: 'executor',
    fromModel: modelRef(metadata, 'planner'),
    toModel: modelRef(metadata, 'executor'),
    toolPairs: results.map((result) => ({
      callId: result.toolCallId,
      name: result.name,
      ok: result.ok,
      result: result.content,
    })),
    completedEffects: [],
    ...(failed ? { failureEvidence: { stepId: failed.toolCallId, evidence: failed.content } } : {}),
  };
}

/** Enter planner_readonly when needed and stamp handoffRole before the model call. */
export async function prepareExplicitSessionHandoff(
  host: Pick<TurnKernelHost, 'store' | 'mergeSessionMetadata'>,
  sessionId: string,
): Promise<void> {
  const session = host.store.getSession(sessionId);
  if (!session) return;
  const metadata = asRecord(session.metadata);
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return;
  let kernel = readKernel(metadata);
  if (!kernel) {
    const prepared = await prepareTrajectoryToolWave({
      id: sessionId,
      metadata: { ...metadata, handoffState: 'planner_readonly', handoffEntering: 'planner_readonly' },
    });
    if (!prepared.ok) return;
    kernel = createInitialKernelState({ now: new Date().toISOString(), turnNumber: 1 });
  }
  const role = roleFor(kernel.state);
  host.mergeSessionMetadata(sessionId, {
    handoffKernel: kernel,
    handoffState: kernel.state,
    ...(role ? { handoffRole: role } : {}),
  });
}

/**
 * A successful submit_plan moves planner_readonly → plan_ready → executor_write (+1)
 * and stores one context pack on this session.
 */
export function advanceExplicitHandoffAfterTools(
  metadata: Record<string, unknown> | undefined,
  results: readonly ToolExecResult[],
): Record<string, unknown> | undefined {
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return undefined;
  const accepted = results.find((result) =>
    result.ok && (result.name === 'submit_plan' || result.metadata?.handoffPlanAccepted === true)
  );
  if (!accepted) return undefined;
  const now = new Date().toISOString();
  let kernel = readKernel(metadata) ?? createInitialKernelState({ now, turnNumber: 1 });
  if (kernel.state === 'planner_readonly') {
    const submitted = applyTransition(kernel, 'submit_plan', now);
    if (!submitted.ok) return undefined;
    kernel = submitted.next;
  }
  if (kernel.state !== 'plan_ready') return undefined;
  const activated = applyTransition(kernel, 'activate_executor', now);
  if (!activated.ok) return undefined;
  const versionRaw = accepted.metadata?.planVersion;
  const planVersion = typeof versionRaw === 'number' && versionRaw > 0 ? Math.floor(versionRaw) : 1;
  return {
    handoffKernel: activated.next,
    handoffState: activated.next.state,
    handoffRole: 'executor',
    handoffContext: packFrom(metadata, results, planVersion),
  };
}

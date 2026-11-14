/**
 * Single trajectory-handoff tool gate.
 * Effective permission = original ∩ host phase ∩ current role.
 * Tokens come from tool access and side-effect level, not from the tool name.
 * Production stays off unless the session explicitly enables handoff.
 */

import { parseCapabilityTiers } from './config.js';
import { createTrajectoryHandoffAdapter } from './adapter.js';
import { DEFAULT_SESSION_CAP, type HandoffState } from './types.js';
import { trajectoryHandoffGateFromMetadata } from '../runtime/run-profile.js';
import type { ToolExecResult } from '../turn/host.js';

export type HandoffPerm = 'read' | 'write' | 'command' | 'delegate' | 'external';

const ALL_PERMS: readonly HandoffPerm[] = ['read', 'write', 'command', 'delegate', 'external'];
const PLANNER_STATE: Record<string, true> = { planner_readonly: true, planner_repair: true };
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

const inflightWrites = new Map<string, Set<string>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function trajectoryToolPermission(tool: { access?: string; sideEffectLevel?: string }): HandoffPerm {
  const access = tool.access;
  const side = tool.sideEffectLevel;
  if (access === 'delegate') return 'delegate';
  if (access === 'bash' || access === 'network') return 'command';
  if (access === 'edit') return 'write';
  if (access === 'other') return 'command';
  if (access === 'read' && (side === 'none' || side == null)) return 'read';
  if (side === 'none') return 'read';
  if (side === 'workspace' || side === 'system') return 'write';
  return 'command';
}

function originalPerms(metadata: Record<string, unknown> | undefined): Set<HandoffPerm> {
  const raw = metadata?.originalPerms;
  if (!Array.isArray(raw)) return new Set(ALL_PERMS);
  const picked = raw.filter((item): item is HandoffPerm =>
    item === 'read' || item === 'write' || item === 'command' || item === 'delegate' || item === 'external'
  );
  return new Set(picked);
}

function handoffStateOf(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.handoffState === 'string' ? metadata.handoffState : 'planner_readonly';
}

export function noteTrajectoryWrite(sessionId: string, callId: string): void {
  let pending = inflightWrites.get(sessionId);
  if (!pending) {
    pending = new Set();
    inflightWrites.set(sessionId, pending);
  }
  pending.add(callId);
}

export function trajectoryWritesPending(sessionId: string): boolean {
  const pending = inflightWrites.get(sessionId);
  return Boolean(pending && pending.size > 0);
}

export function finishTrajectoryWrite(sessionId: string, callId: string): void {
  inflightWrites.get(sessionId)?.delete(callId);
}

export function beginTrajectoryWrite(
  session: { id: string; metadata?: unknown } | undefined,
  tool: { access?: string; sideEffectLevel?: string },
  callId: string
): boolean {
  if (!session) return false;
  const metadata = asRecord(session.metadata);
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return false;
  if (trajectoryToolPermission(tool) === 'read') return false;
  noteTrajectoryWrite(session.id, callId);
  return true;
}

/** Denial reason, or undefined when the tool may run. Disabled handoff allows it. */
export function denyTrajectoryTool(
  session: { metadata?: unknown } | undefined,
  tool: { name: string; access?: string; sideEffectLevel?: string; planStore?: { kind?: string } }
): string | undefined {
  const metadata = asRecord(session?.metadata);
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return undefined;
  const state = handoffStateOf(metadata);
  if (!Object.prototype.hasOwnProperty.call(KNOWN_STATE, state)) {
    return `Tool execution not allowed in handoff state ${state}`;
  }
  const planner = state in PLANNER_STATE;
  const executor = state in EXECUTOR_STATE;
  if (!planner && !executor) return `Tool execution not allowed in handoff state ${state}`;
  const original = originalPerms(metadata);
  const phase = typeof metadata?.hostPhase === 'string' ? metadata.hostPhase : 'ordinary';
  if (
    tool.planStore?.kind === 'plan_state'
    && (planner || executor)
    && phase !== 'research'
    && phase !== 'review'
  ) {
    return undefined;
  }
  const phaseSet = phase === 'research' || phase === 'review' ? new Set<HandoffPerm>(['read']) : new Set(original);
  const roleSet = planner ? new Set<HandoffPerm>(['read']) : new Set(original);
  const perm = trajectoryToolPermission(tool);
  const adapter = createTrajectoryHandoffAdapter({
    kernelState: state as HandoffState,
    originalAuth: original,
    hostPhaseAuth: phaseSet,
    roleAuth: roleSet,
    currentRole: planner ? 'planner' : 'executor',
    config: { enabled: true },
    currentPlan: null,
  });
  const decision = adapter.validateToolCall(perm, perm !== 'read');
  return decision.allowed ? undefined : (decision.reason ?? 'tool denied by trajectory handoff');
}

/** Planner entry with a write still in flight fails closed. Disabled handoff is a no-op. */
export async function prepareTrajectoryToolWave(
  session: { id: string; metadata?: unknown }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const metadata = asRecord(session.metadata);
  if (!trajectoryHandoffGateFromMetadata(metadata).enabled) return { ok: true };
  const state = handoffStateOf(metadata);
  const entering = metadata?.handoffEntering;
  const planner = state in PLANNER_STATE || entering === 'planner_readonly' || entering === 'planner_repair';
  if (!planner) return { ok: true };
  const pending = inflightWrites.get(session.id);
  if (!pending || pending.size === 0) return { ok: true };
  const adapter = createTrajectoryHandoffAdapter({
    kernelState: 'executor_write',
    originalAuth: new Set(['write']),
    hostPhaseAuth: new Set(['write']),
    roleAuth: new Set(['write']),
    currentRole: 'executor',
    config: { enabled: true },
    currentPlan: null,
  });
  for (const callId of pending) adapter.trackWrite(callId);
  try {
    await adapter.drainWrites();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, reason: `in-flight writes still pending: ${pending.size}` };
}

const PLANNING_REQUIRED = 'Planning required before this side-effect tool can run.';

function sessionHandoffCount(metadata: Record<string, unknown> | undefined): number {
  const counters = asRecord(asRecord(metadata?.handoffKernel)?.counters);
  if (typeof counters?.sessionHandoffs === 'number' && Number.isFinite(counters.sessionHandoffs)) {
    return counters.sessionHandoffs;
  }
  if (typeof metadata?.handoffSessionCount === 'number' && Number.isFinite(metadata.handoffSessionCount)) {
    return metadata.handoffSessionCount;
  }
  return 0;
}

function configuredSessionCap(metadata: Record<string, unknown> | undefined): number {
  const parsed = parseCapabilityTiers(metadata?.capabilityTiers);
  if (!parsed.ok) return DEFAULT_SESSION_CAP;
  return parsed.resolved.perSessionCap;
}

/** Unsandboxed bash/shell/browser/http/mcp stay controlled even if tagged read. */
function mistaggedControlled(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.includes('sandbox')) return false;
  return /(?:^|[^a-z0-9])(?:bash|shell|browser|https?|mcp)(?:[^a-z0-9]|$)/.test(normalized);
}

/**
 * Auto-eligible wave: pure reads run. A controlled call under the session cap
 * enters planner_readonly and is denied. An exhausted session budget stays on
 * the old path and does not clear counters.
 */
export async function executeAutoEligibleToolWave(input: {
  session: { id: string; metadata?: unknown };
  calls: ReadonlyArray<{ toolCallId: string; name: string; input: Record<string, unknown> }>;
  tools: ReadonlyArray<{ name: string; access?: string; sideEffectLevel?: string }>;
  execute: (
    calls: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }>,
  ) => Promise<ToolExecResult[]>;
  enterPlanner: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}): Promise<ToolExecResult[]> {
  const metadata = asRecord(input.session.metadata);
  const catalog = new Map(input.tools.map((tool) => [tool.name, tool]));
  const reads: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }> = [];
  const controlled: Array<{ toolCallId: string; name: string; input: Record<string, unknown> }> = [];
  for (const call of input.calls) {
    const tool = catalog.get(call.name) ?? { name: call.name };
    if (trajectoryToolPermission(tool) === 'read' && !mistaggedControlled(tool.name)) reads.push(call);
    else controlled.push(call);
  }
  if (controlled.length === 0 || sessionHandoffCount(metadata) >= configuredSessionCap(metadata)) {
    return input.execute([...input.calls]);
  }
  const entered = await input.enterPlanner();
  const denial = entered.ok ? PLANNING_REQUIRED : entered.reason;
  const ran = reads.length === 0 ? [] : await input.execute(reads);
  const byId = new Map<string, ToolExecResult>();
  for (const result of ran) byId.set(result.toolCallId, result);
  for (const call of controlled) {
    byId.set(call.toolCallId, { toolCallId: call.toolCallId, name: call.name, ok: false, content: denial });
  }
  return input.calls.map((call) => byId.get(call.toolCallId) ?? {
    toolCallId: call.toolCallId,
    name: call.name,
    ok: false,
    content: 'missing tool result',
  });
}

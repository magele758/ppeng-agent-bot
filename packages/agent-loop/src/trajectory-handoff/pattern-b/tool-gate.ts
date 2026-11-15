/**
 * Unique-entry Pattern B write gate.
 * Missing host key leaves the existing tool path unchanged.
 * Worker claims do not install a boundary.
 */
import { admitWorkerWrite } from './boundary.js';
import { readHostBoundary } from './host-registry.js';
import type { BoundaryRegistry, PatternBRole, WritableBoundary, WriteAdmission } from './types.js';

export interface PatternBCall {
  input?: unknown;
  channel?: string;
  role?: PatternBRole;
  hostOperation?: 'create' | 'integrate' | 'cleanup';
  sharedScopeChange?: boolean;
  workerClaimsIsolation?: boolean;
  workerClaimsSharedWrite?: boolean;
  workerClaimsSkipGate?: boolean;
}

const PATH_KEYS: Record<string, true> = {
  path: true,
  paths: true,
  file_path: true,
  filePath: true,
  target: true,
  destination: true,
  dest: true,
  cwd: true,
  workdir: true,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function controlledName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.includes('sandbox')) return false;
  return normalized.includes('bash')
    || normalized.includes('shell')
    || normalized.includes('browser')
    || normalized.includes('http')
    || normalized.includes('mcp');
}

function hostOperationOf(name: string, call?: PatternBCall): PatternBCall['hostOperation'] {
  if (call?.hostOperation) return call.hostOperation;
  const normalized = name.toLowerCase();
  if (normalized.includes('cleanup') || normalized.includes('clean_workspace')) return 'cleanup';
  if (normalized.includes('integrate')) return 'integrate';
  if (normalized.includes('create_workspace') || normalized.includes('createworkspace')) return 'create';
  return undefined;
}

function writeLike(tool: { name: string; access?: string; sideEffectLevel?: string }, call?: PatternBCall): boolean {
  if (call?.hostOperation || call?.sharedScopeChange || call?.channel) return true;
  if (hostOperationOf(tool.name)) return true;
  if (tool.access === 'read' && tool.sideEffectLevel !== 'command' && tool.sideEffectLevel !== 'write' && !controlledName(tool.name)) {
    return false;
  }
  return true;
}

function channelOf(name: string, call?: PatternBCall): string {
  if (typeof call?.channel === 'string' && call.channel.length > 0) return call.channel;
  const normalized = name.toLowerCase();
  if (normalized.includes('bash') || normalized.includes('shell')) return 'shell';
  if (normalized.includes('mcp')) return 'mcp';
  if (normalized.includes('browser')) return 'browser';
  if (normalized.includes('http')) return 'http';
  if (normalized.includes('subagent') || normalized.includes('delegate')) return 'subagent';
  if (normalized.includes('dynamic')) return 'dynamic';
  if (normalized.includes('batch')) return 'batch';
  return 'tool';
}

function absoluteTokens(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(/(?:^|[\s"'`=])(\/[^\s"'`$;&|<>]+)/g)) {
    const token = match[1];
    if (token && token.length > 1) found.push(token);
  }
  return found;
}

function collectPaths(input: unknown): string[] {
  const record = asRecord(input);
  if (!record) return [];
  const found: string[] = [];
  const add = (key: string, value: string) => {
    if (PATH_KEYS[key] === true && value.length > 0) found.push(value);
    for (const token of absoluteTokens(value)) found.push(token);
  };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') add(key, value);
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item === 'string') add(key, item);
  }
  return found;
}

function ownBoundary(registry: BoundaryRegistry, metadata: Record<string, unknown>): WritableBoundary | undefined {
  const runId = metadata.patternBRunId;
  const workerId = metadata.patternBWorkerId;
  const taskScope = metadata.patternBTaskScope;
  if (typeof runId !== 'string' || typeof workerId !== 'string' || typeof taskScope !== 'string') return undefined;
  return registry.boundaries.find((boundary) =>
    boundary.identity.runId === runId
    && boundary.identity.workerId === workerId
    && boundary.identity.taskScope === taskScope
  );
}

function roleFor(own: WritableBoundary, metadata: Record<string, unknown>, call?: PatternBCall): PatternBRole {
  if (own.role === 'planner' || metadata.patternBRole === 'planner' || call?.role === 'planner') return 'planner';
  return own.role;
}

function planMismatch(own: WritableBoundary, metadata: Record<string, unknown>): boolean {
  if (own.identity.planId !== undefined && metadata.patternBPlanId !== own.identity.planId) return true;
  return own.identity.planVersion !== undefined && metadata.patternBPlanVersion !== own.identity.planVersion;
}

function admissionFor(
  own: WritableBoundary,
  metadata: Record<string, unknown>,
  tool: { name: string },
  call: PatternBCall | undefined,
  path: string,
): WriteAdmission {
  const sharedScope = call?.sharedScopeChange === true || asRecord(call?.input)?.sharedScopeChange === true;
  const admission: WriteAdmission = {
    actor: { ...own.identity },
    role: roleFor(own, metadata, call),
    channel: channelOf(tool.name, call),
    path,
    workerClaimsIsolation: call?.workerClaimsIsolation === true,
    workerClaimsSharedWrite: call?.workerClaimsSharedWrite === true,
    workerClaimsSkipGate: call?.workerClaimsSkipGate === true,
  };
  const operation = hostOperationOf(tool.name, call);
  if (operation) admission.hostOperation = operation;
  if (sharedScope) admission.sharedScopeChange = true;
  return admission;
}

export function denyPatternBTool(
  session: { metadata?: unknown } | undefined,
  tool: { name: string; access?: string; sideEffectLevel?: string },
  call?: PatternBCall,
): string | undefined {
  const metadata = asRecord(session?.metadata);
  if (!metadata || typeof metadata.patternBHostKey !== 'string') return undefined;
  const registry = readHostBoundary(metadata.patternBHostKey);
  if (!registry || registry.hostEnforced !== true || typeof registry.canonicalize !== 'function') {
    return writeLike(tool, call) ? 'Pattern B isolation is not host-enforced' : undefined;
  }
  if (!writeLike(tool, call)) return undefined;
  const own = ownBoundary(registry, metadata);
  if (!own || planMismatch(own, metadata)) return 'Pattern B isolation is not host-enforced';
  const paths = collectPaths(call?.input);
  const targets = paths.length > 0 ? paths : [''];
  for (const path of targets) {
    const decision = admitWorkerWrite(registry, admissionFor(own, metadata, tool, call, path));
    if (!decision.allowed) return decision.reason;
  }
  return undefined;
}

export function patternBBoundaryPending(
  metadata: Record<string, unknown> | undefined,
  pending: boolean,
): { ok: false; reason: string } | undefined {
  if (!metadata || typeof metadata.patternBHostKey !== 'string' || !pending) return undefined;
  const entering = metadata.handoffEntering;
  const state = typeof metadata.handoffState === 'string' ? metadata.handoffState : '';
  const planner = state === 'planner_readonly'
    || state === 'planner_repair'
    || entering === 'planner_readonly'
    || entering === 'planner_repair';
  if (!planner && metadata.patternBBoundaryCross !== true) return undefined;
  return { ok: false, reason: 'in-flight writes still pending across Pattern B boundary' };
}

export function patternBBlockedCalls<T extends { toolCallId: string; name: string; input?: unknown }>(
  session: { metadata?: unknown },
  calls: readonly T[],
  tools: ReadonlyArray<{ name: string; access?: string; sideEffectLevel?: string }>,
): { denied: Map<string, string>; allowed: T[] } | undefined {
  const metadata = asRecord(session.metadata);
  if (typeof metadata?.patternBHostKey !== 'string') return undefined;
  const catalog = new Map(tools.map((tool) => [tool.name, tool]));
  const denied = new Map<string, string>();
  const allowed: T[] = [];
  for (const call of calls) {
    const tool = catalog.get(call.name) ?? { name: call.name };
    const reason = denyPatternBTool(session, tool, { input: call.input });
    if (reason) denied.set(call.toolCallId, reason);
    else allowed.push(call);
  }
  return { denied, allowed };
}

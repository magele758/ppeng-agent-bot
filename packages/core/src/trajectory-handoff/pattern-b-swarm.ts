/**
 * Independent Swarm host wiring for Pattern B.
 * Flywheel runs stay on the non-isolation path. Missing enforcement fails closed.
 */
import {
  hostBoundaryKey,
  installHostBoundary,
  type BoundaryRegistry,
  type LifecycleStore,
  type PatternBRole,
  type WritableBoundary,
} from '@ppeng/agent-loop/pattern-b';
import type { QualityReport } from '../quality/gate.js';
import type { SessionRecord } from '../types.js';
import type { SwarmRun, SwarmTask } from '../swarm/types.js';
import {
  admitPatternBIsolation,
  PATTERN_B_ISOLATION_TASK_TAG,
  rememberPatternBIsolation,
  type PatternBDenyReason,
  type PatternBTrustedContext,
} from './pattern-b-entry.js';

export interface PatternBExecutorConfig {
  enabled: boolean;
  explicitOff: boolean;
  boundaryFor?: (run: SwarmRun, task: SwarmTask) => BoundaryRegistry | undefined;
  readRecords?: () => unknown;
  writeRecords?: (value: unknown) => void;
  lifecycles?: LifecycleStore;
  acceptDelivery?: (session: SessionRecord, report: QualityReport) => boolean | undefined;
  now?: () => string;
}

export type PatternBDispatch =
  | { readonly kind: 'inactive' }
  | { readonly kind: 'fail_closed'; readonly reason: string }
  | { readonly kind: 'admit'; readonly metadata: Record<string, unknown> };

function closedDispatch(reason: PatternBDenyReason): PatternBDispatch {
  return reason === 'not_enforced' ? { kind: 'fail_closed', reason } : { kind: 'inactive' };
}

function flywheelRun(run: SwarmRun, trusted: PatternBTrustedContext | null | undefined): boolean {
  if (typeof run.orchestrationRunId === 'string' && run.orchestrationRunId.length > 0) return true;
  if (typeof trusted?.orchestrationRunId === 'string' && trusted.orchestrationRunId.length > 0) return true;
  return trusted?.source === 'flywheel';
}

function trustedFor(
  run: SwarmRun,
  config: PatternBExecutorConfig,
  trusted: PatternBTrustedContext | null | undefined,
  boundary: BoundaryRegistry | undefined,
): PatternBTrustedContext {
  const explicitOff = config.explicitOff === true || trusted?.patternBExplicitOff === true;
  return {
    source: flywheelRun(run, trusted) ? 'flywheel' : 'independent_swarm',
    orchestrationRunId: run.orchestrationRunId ?? trusted?.orchestrationRunId ?? null,
    patternBEnabled: config.enabled === true && !explicitOff && trusted?.patternBEnabled !== false,
    patternBExplicitOff: explicitOff,
    isolationTask: true,
    patternBHostEnforced: boundary?.hostEnforced === true,
    patternBCanonicalizer: typeof boundary?.canonicalize === 'function',
  };
}

function withTaskRole(registry: BoundaryRegistry, own: WritableBoundary, task: SwarmTask): BoundaryRegistry {
  const restrictive = task.requiredRole !== 'implementer' || own.role === 'planner';
  const role: PatternBRole = restrictive ? 'planner' : 'executor';
  const replacement: WritableBoundary = {
    ...own,
    role,
    effectiveWrite: !restrictive && own.effectiveWrite === true,
  };
  return {
    ...registry,
    boundaries: registry.boundaries.map((boundary) =>
      boundary.identity.runId === own.identity.runId && boundary.identity.workerId === own.identity.workerId
        ? replacement
        : boundary
    ),
  };
}

function stampMetadata(own: WritableBoundary, key: string, role: PatternBRole): Record<string, unknown> {
  return {
    patternBHostKey: key,
    patternBRunId: own.identity.runId,
    patternBWorkerId: own.identity.workerId,
    patternBTaskScope: own.identity.taskScope,
    patternBRole: role,
    ...(own.identity.planId ? { patternBPlanId: own.identity.planId } : {}),
    ...(own.identity.planVersion ? { patternBPlanVersion: own.identity.planVersion } : {}),
  };
}

function persistAdmission(
  config: PatternBExecutorConfig,
  run: SwarmRun,
  task: SwarmTask,
  now: string,
): string | undefined {
  const remembered = rememberPatternBIsolation(config.readRecords?.() ?? null, {
    runId: run.id,
    workerId: task.id,
    persistedAt: now,
  });
  if (!remembered.ok) return 'unreadable_records';
  config.writeRecords?.(remembered.records);
  return undefined;
}

function admitDispatch(
  run: SwarmRun,
  task: SwarmTask,
  config: PatternBExecutorConfig,
  boundary: BoundaryRegistry,
  now: string,
): PatternBDispatch {
  const own = boundary.boundaries.find((item) => item.identity.runId === run.id && item.identity.workerId === task.id);
  if (!own) return { kind: 'fail_closed', reason: 'not_enforced' };
  const installed = withTaskRole(boundary, own, task);
  const stamped = installed.boundaries.find((item) => item.identity.workerId === task.id);
  if (!stamped) return { kind: 'fail_closed', reason: 'not_enforced' };
  if (config.lifecycles) {
    const created = config.lifecycles.create({
      actor: { kind: 'host' },
      runId: run.id,
      workerId: task.id,
      taskScope: own.identity.taskScope,
      writableRoot: own.writableRoot,
      ...(own.identity.planId ? { planId: own.identity.planId } : {}),
      ...(own.identity.planVersion ? { planVersion: own.identity.planVersion } : {}),
      now,
    });
    if (!created.ok) return { kind: 'fail_closed', reason: created.reason };
  }
  const persistError = persistAdmission(config, run, task, now);
  if (persistError) return { kind: 'fail_closed', reason: persistError };
  const key = hostBoundaryKey(own.identity.runId, own.identity.workerId);
  installHostBoundary(key, installed);
  return { kind: 'admit', metadata: stampMetadata(stamped, key, stamped.role) };
}

export function resolvePatternBDispatch(input: {
  readonly run: SwarmRun;
  readonly task: SwarmTask;
  readonly config: PatternBExecutorConfig;
  readonly trusted?: PatternBTrustedContext | null;
  readonly now: string;
}): PatternBDispatch {
  if (!input.task.capabilityTags.includes(PATTERN_B_ISOLATION_TASK_TAG)) return { kind: 'inactive' };
  const boundary = input.config.boundaryFor?.(input.run, input.task);
  const admission = admitPatternBIsolation({
    trusted: trustedFor(input.run, input.config, input.trusted, boundary),
    workerMetadata: null,
  });
  if (!admission.open) return closedDispatch(admission.reason);
  if (!boundary) return { kind: 'fail_closed', reason: 'not_enforced' };
  return admitDispatch(input.run, input.task, input.config, boundary, input.now);
}

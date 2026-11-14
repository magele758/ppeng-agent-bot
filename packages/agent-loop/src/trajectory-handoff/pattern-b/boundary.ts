/**
 * Writable-boundary guard for one worker workspace.
 * A separate directory is not isolation. Production entry is not opened here.
 */
import { pathContained } from './paths.js';
import {
  WRITE_CHANNELS,
  type BoundaryDecision,
  type BoundaryDenyCode,
  type BoundaryRegistry,
  type PatternBRole,
  type WorkspaceLifecycleRecord,
  type WritableBoundary,
  type WriteAdmission,
} from './types.js';

function deny(code: BoundaryDenyCode, reason: string): BoundaryDecision {
  return { allowed: false, code, reason };
}

export function boundaryFromLifecycle(
  record: WorkspaceLifecycleRecord,
  role: PatternBRole,
  effectiveWrite: boolean,
): WritableBoundary {
  const identity: WritableBoundary['identity'] = {
    runId: record.runId,
    workerId: record.workerId,
    taskScope: record.taskScope,
  };
  if (record.planId !== undefined) identity.planId = record.planId;
  if (record.planVersion !== undefined) identity.planVersion = record.planVersion;
  return {
    identity,
    writableRoot: record.writableRoot,
    role,
    effectiveWrite,
  };
}

function earlyWriteDenial(admission: WriteAdmission): BoundaryDecision | undefined {
  if (admission.workerClaimsSkipGate === true) {
    return deny('self_reported', 'Worker self-report cannot skip the gate');
  }
  if (
    admission.hostOperation === 'create'
    || admission.hostOperation === 'integrate'
    || admission.hostOperation === 'cleanup'
  ) {
    return deny('host_operation', 'Create, integrate, and cleanup are host-controlled');
  }
  if (admission.sharedScopeChange === true) {
    return deny('shared_scope_escalated', 'Shared scope changes are refused locally');
  }
  return undefined;
}

function resolveOwnBoundary(registry: BoundaryRegistry, admission: WriteAdmission): WritableBoundary | BoundaryDecision {
  const matches = registry.boundaries.filter((boundary) =>
    boundary.identity.runId === admission.actor.runId
    && boundary.identity.workerId === admission.actor.workerId
    && boundary.identity.taskScope === admission.actor.taskScope
  );
  const own = matches.length === 1 ? matches[0] : undefined;
  if (!own) return deny('not_enforced', 'Host boundary enforcement is required');
  if (own.identity.planId !== undefined && admission.actor.planId !== own.identity.planId) {
    return deny('outside_writable', 'Write path is outside the worker writable root');
  }
  if (own.identity.planVersion !== undefined && admission.actor.planVersion !== own.identity.planVersion) {
    return deny('outside_writable', 'Write path is outside the worker writable root');
  }
  if (admission.role === 'planner' || own.role === 'planner') {
    return deny('planner_write', 'Planner role cannot write');
  }
  if (own.effectiveWrite !== true) {
    return deny('permission_denied', 'Write is outside the permission intersection');
  }
  return own;
}

type CanonicalRoots = {
  ownRoot: string;
  otherRoots: string[];
  mounts: string[];
  shared: string[];
};

function canonicalizeRoots(registry: BoundaryRegistry, own: WritableBoundary): CanonicalRoots | BoundaryDecision {
  const canonicalize = registry.canonicalize;
  if (typeof canonicalize !== 'function') {
    return deny('not_enforced', 'Host boundary enforcement is required');
  }
  try {
    const canonicalOwn = canonicalize(own.writableRoot);
    if (typeof canonicalOwn !== 'string') return deny('not_enforced', 'Host boundary enforcement is required');
    const otherRoots: string[] = [];
    const mounts: string[] = [];
    const shared: string[] = [];
    for (const boundary of registry.boundaries) {
      if (boundary === own) continue;
      const canonical = canonicalize(boundary.writableRoot);
      if (typeof canonical !== 'string') return deny('not_enforced', 'Host boundary enforcement is required');
      otherRoots.push(canonical);
    }
    for (const mount of registry.readOnlyMounts) {
      const canonical = canonicalize(mount.path);
      if (typeof canonical !== 'string') return deny('not_enforced', 'Host boundary enforcement is required');
      mounts.push(canonical);
    }
    for (const target of registry.sharedTargets) {
      const canonical = canonicalize(target.path);
      if (typeof canonical !== 'string') return deny('not_enforced', 'Host boundary enforcement is required');
      shared.push(canonical);
    }
    return { ownRoot: canonicalOwn, otherRoots, mounts, shared };
  } catch {
    return deny('not_enforced', 'Host boundary enforcement is required');
  }
}

function decideAdmittedPath(admitted: string, roots: CanonicalRoots): BoundaryDecision {
  if (roots.mounts.some((root) => pathContained(root, admitted))) {
    return deny('read_only_mount', 'Read-only mounts cannot be written');
  }
  if (roots.shared.some((root) => pathContained(root, admitted))) {
    return deny('shared_target', 'Shared integration target cannot be written by a worker');
  }
  if (roots.otherRoots.some((root) => pathContained(root, admitted))) {
    return deny('other_worker', 'Another worker workspace cannot be written');
  }
  if (pathContained(roots.ownRoot, admitted)) return { allowed: true };
  return deny('outside_writable', 'Write path is outside the worker writable root');
}

export function admitWorkerWrite(registry: BoundaryRegistry, admission: WriteAdmission): BoundaryDecision {
  const early = earlyWriteDenial(admission);
  if (early) return early;
  if (registry.hostEnforced !== true || typeof registry.canonicalize !== 'function') {
    return deny('not_enforced', 'Host boundary enforcement is required');
  }
  const canonicalize = registry.canonicalize;

  let admitted: string;
  try {
    const value = canonicalize(admission.path);
    if (typeof value !== 'string') return deny('outside_writable', 'Write path is outside the worker writable root');
    admitted = value;
  } catch {
    return deny('not_enforced', 'Host boundary enforcement is required');
  }
  if (!WRITE_CHANNELS.some((channel) => channel === admission.channel)) {
    return deny('unscoped_channel', 'Unscoped write channel');
  }

  const own = resolveOwnBoundary(registry, admission);
  if ('allowed' in own) return own;
  const roots = canonicalizeRoots(registry, own);
  if ('allowed' in roots) return roots;
  return decideAdmittedPath(admitted, roots);
}

/**
 * Pattern B entry-closed primitives.
 * These records do not decide trajectory handoff and do not grant budget.
 * Production entry stays closed; nothing here is a user-facing enable switch.
 */

export const PATTERN_B_PRODUCTION_ENTRY = 'closed' as const;
export type PatternBProductionEntry = typeof PATTERN_B_PRODUCTION_ENTRY;

export type PatternBRole = 'planner' | 'executor';

export interface WorkerIdentity {
  runId: string;
  workerId: string;
  taskScope: string;
  planId?: string;
  planVersion?: string;
}

export interface WritableBoundary {
  identity: WorkerIdentity;
  /** Canonical absolute writable root. A separate directory is not isolation. */
  writableRoot: string;
  role: PatternBRole;
  /** Original authorization ∩ host phase ∩ current role. */
  effectiveWrite: boolean;
}

export interface SharedTargetRef {
  targetId: string;
  /** Canonical absolute path of the shared integration target. */
  path: string;
  expectedVersion: string;
}

export interface ReadOnlyMount {
  path: string;
  kind: 'input' | 'cache' | 'plan';
}

export interface BoundaryRegistry {
  boundaries: readonly WritableBoundary[];
  sharedTargets: readonly SharedTargetRef[];
  readOnlyMounts: readonly ReadOnlyMount[];
  /**
   * Host armed the unique-entry enforcer. False means isolation must not
   * be claimed, even if directories already differ.
   */
  hostEnforced: boolean;
  /**
   * Host canonicalizer (realpath or equivalent). Required when enforced.
   * Missing canonicalizer fails closed.
   */
  canonicalize?: (path: string) => string | undefined;
}

export type BoundaryDenyCode =
  | 'entry_closed'
  | 'not_enforced'
  | 'planner_write'
  | 'permission_denied'
  | 'outside_writable'
  | 'other_worker'
  | 'shared_target'
  | 'read_only_mount'
  | 'unscoped_channel'
  | 'self_reported'
  | 'host_operation'
  | 'shared_scope_escalated';

export type BoundaryDecision =
  | { allowed: true }
  | { allowed: false; code: BoundaryDenyCode; reason: string };

export interface WriteAdmission {
  actor: WorkerIdentity;
  role: PatternBRole;
  /** Known channels share one path rule. Any other string is unscoped. */
  channel: string;
  path: string;
  /** Ignored as authorization. A skip-gate claim is always denied. */
  workerClaimsIsolation?: boolean;
  workerClaimsSharedWrite?: boolean;
  workerClaimsSkipGate?: boolean;
  /** Write would change a shared interface, dependency, or acceptance rule. */
  sharedScopeChange?: boolean;
  /** Create / integrate / cleanup are host operations, not worker tools. */
  hostOperation?: 'create' | 'integrate' | 'cleanup';
}

export const WRITE_CHANNELS = [
  'tool',
  'shell',
  'mcp',
  'browser',
  'http',
  'subagent',
  'dynamic',
  'batch',
] as const;
export type WriteChannel = (typeof WRITE_CHANNELS)[number];

export type LifecyclePhase = 'created' | 'retained' | 'cleanup_pending' | 'cleaned';

/** Audit record only. No handoff state and no budget fields. */
export interface WorkspaceLifecycleRecord {
  lifecycleId: string;
  runId: string;
  workerId: string;
  taskScope: string;
  planId?: string;
  planVersion?: string;
  writableRoot: string;
  phase: LifecyclePhase;
  discardConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type IntegrationStatus =
  | 'authorized'
  | 'applying'
  | 'unknown'
  | 'accepted'
  | 'rejected'
  | 'expired';

export interface IntegrationBinding {
  integrationId: string;
  runId: string;
  workerId: string;
  planVersion: string;
  taskScope: string;
  artifactVersion: string;
  targetId: string;
  expectedTargetVersion: string;
  /** Version the target becomes if this integration is the one accepted. */
  resultTargetVersion: string;
  deadlineAt: string;
  authorizedAt: string;
}

export interface IntegrationRecord extends IntegrationBinding {
  status: IntegrationStatus;
  sideEffectCount: number;
  logicalKey: string;
  observedTargetVersion?: string;
  reason?: string;
}

export interface ReconcileEvidence {
  observed: 'applied' | 'not_applied' | 'unavailable';
  observedTargetVersion?: string;
}

export type LifecycleActor = { kind: 'host' } | { kind: 'worker'; workerId: string };

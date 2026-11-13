/**
 * Trajectory Handoff v2.3 — type definitions.
 *
 * Pure type algebra; no runtime dependencies.
 * All state machine states, events, plan objects, and port interfaces are
 * declared here.  Implementations live in peer files.
 */

// ============================================================================
// State machine states
// ============================================================================

/** Active (non-terminal, non-suspend) states. */
export type HandoffActiveState =
  | 'planner_readonly'
  | 'plan_ready'
  | 'executor_write'
  | 'planner_repair';

/** Suspend state — recoverable, not terminal, not task termination. */
export type HandoffSuspendState = 'awaiting_coordinator';

/** Terminal states.  Once reached, no re-entry. */
export type HandoffTerminalState =
  | 'answered'
  | 'done'
  | 'capped'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type HandoffState = HandoffActiveState | HandoffSuspendState | HandoffTerminalState;

// ============================================================================
// State machine events
// ============================================================================

export type HandoffEvent =
  // planner_readonly edges
  | 'direct_answer'          // → answered
  | 'submit_plan'            // → plan_ready
  | 'escalate_no_plan'       // → awaiting_coordinator
  // plan_ready edges
  | 'activate_executor'      // → executor_write (+1 handoff)
  | 'pin_failed'             // → failed
  | 'budget_insufficient'    // → awaiting_coordinator
  // executor_write edges
  | 'local_done'             // → done
  | 'friction'               // → planner_repair (+1 handoff)
  | 'coordinator_resumed'    // awaiting_coordinator → executor_write (+1 against granted quota)
  // planner_repair edges (re-enter executor handled by activate_executor)
  // awaiting_coordinator edges
  | 'coordinator_no_plan'    // → planner_readonly
  | 'coordinator_repair'     // → planner_repair
  // shared terminal triggers
  | 'cap_exceeded'           // → capped
  | 'fail'                   // → failed
  | 'cancel'                 // → cancelled
  | 'timeout'                // → timed_out
  // shared planner_readonly/plan_ready/executor_write/planner_repair/awaiting_coordinator
  | 'escalate';              // → awaiting_coordinator (shared-scope / general escalate)

// ============================================================================
// Plan objects
// ============================================================================

export type PlanStatus = 'draft' | 'accepted' | 'superseded' | 'failed';

/** A single step within a plan. */
export interface PlanStep {
  readonly id: string;
  readonly description: string;
  readonly dependsOn?: readonly string[];
}

/**
 * Immutable plan object.  Mutations create a new version via PlanStore
 * (expectedOldVersion + newVersion).
 */
export interface PlanObject {
  readonly planId: string;
  /** Monotonically increasing; starts at 1 on the first accepted plan. */
  readonly version: number;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  /** ISO-8601 timestamp of when this version was created. */
  readonly createdAt: string;
  /** Free-form rationale stored with the plan for dual-model context. */
  readonly rationale?: string;
}

// ============================================================================
// Handoff counters
// ============================================================================

export interface HandoffCounters {
  /** Total handoffs consumed in this session (max 6). */
  readonly sessionHandoffs: number;
  /** Handoffs consumed in the current turn (max 3, reset each turn). */
  readonly turnHandoffs: number;
}

export const DEFAULT_SESSION_CAP = 6;
export const DEFAULT_TURN_CAP = 3;

// ============================================================================
// Capability tiers config
// ============================================================================

/**
 * Per-role model identifier.  An empty string or null/undefined means "use
 * the pinned original session model for this role".
 */
export type RoleModelId = string | null | undefined;

export interface CapabilityTierRoles {
  /** Model used for planner phases.  Defaults to pinned session model. */
  readonly plannerModel?: RoleModelId;
  /** Model used for executor phases.  Defaults to pinned session model. */
  readonly executorModel?: RoleModelId;
}

export interface HandoffCapConfig {
  /** Maximum handoffs per session.  Illegal values (<=0) fall back to 6. */
  readonly perSession?: number;
  /** Maximum handoffs per turn.  Illegal values (<=0) fall back to 3.
   *  If perTurn > perSession after validation, it is clamped to perSession. */
  readonly perTurn?: number;
}

export interface CapabilityTiersConfig {
  /** Explicit off has highest priority; ignores all tiers; uses old path. */
  readonly enabled?: boolean;
  readonly roles?: CapabilityTierRoles;
  readonly caps?: HandoffCapConfig;
  /**
   * When true the executor is allowed to inherit a model override that was
   * applied to the session.  MUST NOT pin the executor model onto a planner
   * subtask.
   */
  readonly inheritModelOverride?: boolean;
}

/** Fully-resolved config after defaults and validation.  All fields present. */
export interface ResolvedCapabilityTiers {
  readonly enabled: boolean;
  readonly plannerModel: string | null;
  readonly executorModel: string | null;
  readonly perSessionCap: number;
  readonly perTurnCap: number;
  readonly inheritModelOverride: boolean;
}

// ============================================================================
// Kernel state snapshot
// ============================================================================

export interface HandoffKernelState {
  readonly state: HandoffState;
  readonly plan: PlanObject | null;
  readonly counters: HandoffCounters;
  /** ISO-8601 wall-clock at which the current state was entered. */
  readonly enteredAt: string;
  /** Session-unique turn number (incremented by host on each new turn). */
  readonly turnNumber: number;
}

// ============================================================================
// Ports (interfaces for host/adapter to implement)
// ============================================================================

/** Event sink for state transition telemetry.  Fire-and-forget; never throws. */
export interface HandoffEventSink {
  emit(event: {
    type: 'state_transition';
    from: HandoffState;
    event: HandoffEvent;
    to: HandoffState;
    counters: HandoffCounters;
    at: string;
  }): void;
}

/**
 * PlanStore API for plan persistence.
 * Conflicts must not silently overwrite; expectedOldVersion is required for
 * updates and must match the currently stored version.
 */
export interface PlanStore {
  load(planId: string): Promise<PlanObject | null>;
  save(plan: PlanObject, expectedOldVersion: number | null): Promise<{ ok: true } | { ok: false; conflict: true }>;
}

/**
 * ModelResolver: resolves the effective model id for a given role.
 * Returns null if the role's configured model is invalid AND the pinned
 * original model is also invalid (fail-closed).
 */
export interface ModelResolver {
  resolveForRole(role: 'planner' | 'executor', pinnedSessionModel: string): string | null;
}

/**
 * Reserved refill / coordinator event interface.
 * Swarm host entry stays closed; tests drive this directly.
 */
export interface CoordinatorResumeEvent {
  /** The plan version the coordinator has accepted and is granting quota for. */
  readonly planVersion: number;
  /** Local quota units granted by the coordinator for this resume. */
  readonly grantedQuota: number;
  /** ISO-8601 deadline for the awaiting_coordinator wait window. */
  readonly waitDeadline: string;
  /** True when coordinator_resumed should count 1 against the newly granted quota. */
  readonly countAgainstGrantedQuota: boolean;
}

/**
 * R1 / R2 recovery manifest persisted before each call.
 */
export interface CallReservation {
  readonly reservationId: string;
  readonly callId: string;
  readonly state: HandoffState;
  readonly countersAtIntent: HandoffCounters;
  /** ISO-8601; set at intent time. */
  readonly intentAt: string;
  /** Set when result arrives. */
  outcome?: 'committed' | 'unknown';
}

/** R2: reconcile result for a single reservation. */
export type ReconcileResult =
  | { ok: true; reservation: CallReservation }
  | { ok: false; reason: 'irreconcilable'; reservation: CallReservation }
  | { ok: false; reason: 'unknown_outcome'; reservation: CallReservation };

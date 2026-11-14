/**
 * Trajectory Handoff v2.3 - Core Adapter
 *
 * Stateless adapter: enables/disables mechanism, enforces planner readonly,
 * manages permission intersection, and orchestrates drain logic.
 *
 * NOT authoritative state, NOT budget accounting, NOT resume-position decisions.
 * Kernel owns those.
 *
 * Reserved interfaces (PlanStore, EventSink, CoordinatorResumeEvent) are defined
 * in types.ts; this file depends on them without reimplementing.
 * Swarm HOST ENTRY stays closed; tests may drive reserved interfaces directly.
 */

import type {
  HandoffState,
  CapabilityTiersConfig,
  PlanObject,
} from './types.js';

// ============================================================================
// Adapter-local interfaces
// ============================================================================

/**
 * Effective permission set after intersection of original auth,
 * host phase auth, and current role auth.
 */
export interface EffectivePermissions {
  readonly originalAuth: ReadonlySet<string>;
  readonly hostPhaseAuth: ReadonlySet<string>;
  readonly roleAuth: ReadonlySet<string>;
  /** Triple intersection: original ∩ host phase ∩ role. */
  readonly effective: ReadonlySet<string>;
}

/**
 * Minimal interface the adapter exposes for callers.
 * Does NOT hold authoritative state; delegates accounting to the kernel.
 */
export interface TrajectoryHandoffAdapter {
  isEnabled(): boolean;
  currentRole(): 'planner' | 'executor' | null;
  canExecuteTool(): boolean;
  validateToolCall(toolName: string, isWrite: boolean): { allowed: boolean; reason?: string };
  validatePlanEdit(oldVersion: number, newVersion: number): { allowed: boolean; reason?: string };
  drainWrites(): Promise<void>;
  trackWrite(callId: string): void;
  completeWrite(callId: string): void;
}

export interface AdapterContext {
  kernelState: HandoffState;
  originalAuth: ReadonlySet<string>;
  hostPhaseAuth: ReadonlySet<string>;
  roleAuth: ReadonlySet<string>;
  currentRole: 'planner' | 'executor' | null;
  config: CapabilityTiersConfig;
  currentPlan: PlanObject | null;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Core adapter: enforces planner readonly, permission intersection,
 * and single tool-execution entry for dynamic tools.
 */
export class TrajectoryHandoffAdapterImpl implements TrajectoryHandoffAdapter {
  private context: AdapterContext;
  private inFlightWrites: Set<string> = new Set();

  constructor(context: AdapterContext) {
    this.context = context;
  }

  /**
   * Handoff mechanism enabled?
   * Explicit off has highest priority; do not read tiers in that case.
   * Missing capabilityTiers (config.enabled absent/false) → off.
   */
  isEnabled(): boolean {
    const enabled = this.context.config.enabled;
    // Explicit off wins; missing/absent defaults to false per enablement policy.
    return enabled === true;
  }

  /**
   * Get current effective role.
   */
  currentRole(): 'planner' | 'executor' | null {
    return this.context.currentRole;
  }

  /**
   * Can execute tool in current kernel state?
   * Single entry for all dynamic tools: batch, MCP, Shell, browser, HTTP, subtasks.
   */
  canExecuteTool(): boolean {
    if (!this.isEnabled()) return false;
    const state = this.context.kernelState;
    // Planner states may run tools that survive the permission intersection.
    // plan_ready, suspend, and terminals stay closed.
    return state === 'executor_write' || state === 'planner_readonly' || state === 'planner_repair';
  }

  /**
   * Validate tool call for the single entry point.
   * Effective permissions = original auth ∩ host phase ∩ current role.
   * Reject writes in planner_readonly role.
   *
   * This is the Q&A-to-work re-check; no "no plan needed" write bypass.
   * Generic command tools without reliable readonly isolation are disabled in planner.
   */
  validateToolCall(toolName: string, isWrite: boolean): {
    allowed: boolean;
    reason?: string;
  } {
    // Check if tool execution is allowed in current state.
    if (!this.canExecuteTool()) {
      return {
        allowed: false,
        reason: `Tool execution not allowed in state: ${this.context.kernelState}`,
      };
    }

    // Compute effective permissions.
    const effective = this.computeEffectivePermissions();

    // Check if tool is authorized.
    if (!effective.effective.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool not authorized: ${toolName}. Original: ${effective.originalAuth.has(toolName)}, Host: ${effective.hostPhaseAuth.has(toolName)}, Role: ${effective.roleAuth.has(toolName)}`,
      };
    }

    // Writes only allowed in executor_write (already checked above via canExecuteTool).
    // In planner_readonly, writes are rejected fail-closed.
    if (isWrite && this.context.currentRole === 'planner') {
      return {
        allowed: false,
        reason: `Write operation not allowed in planner role`,
      };
    }

    return { allowed: true };
  }

  /**
   * Validate plan edit through PlanStore API.
   * Plans must be edited via expectedOldVersion + newVersion,
   * not generic file write.  Conflicts must not silently overwrite.
   *
   * This is NOT a generic file write bypass; it's the reserved interface.
   */
  validatePlanEdit(oldVersion: number, newVersion: number): {
    allowed: boolean;
    reason?: string;
  } {
    if (!this.isEnabled()) {
      return { allowed: false, reason: 'Handoff mechanism is disabled' };
    }

    if (!this.context.currentPlan) {
      return { allowed: false, reason: 'No current plan to edit' };
    }

    // Optimistic concurrency: oldVersion must match current plan version.
    if (oldVersion !== this.context.currentPlan.version) {
      return {
        allowed: false,
        reason: `Plan version conflict: expected ${oldVersion}, current ${this.context.currentPlan.version}`,
      };
    }

    // New version must increment.
    if (newVersion <= oldVersion) {
      return {
        allowed: false,
        reason: `Plan version must increment: ${oldVersion} -> ${newVersion}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Drain in-flight writes before entering planner role.
   * Fail-closed if cannot stop safely.
   *
   * This must complete before state transition to planner_readonly or planner_repair.
   */
  async drainWrites(): Promise<void> {
    if (this.inFlightWrites.size === 0) return;
    throw new Error(
      `Failed to drain in-flight writes before planner entry. ` +
      `${this.inFlightWrites.size} writes still pending. ` +
      `Failing closed to prevent data corruption.`
    );
  }

  /**
   * Track in-flight write for drain logic.
   * Called by runtime when tool execution starts.
   */
  trackWrite(callId: string): void {
    this.inFlightWrites.add(callId);
  }

  /**
   * Mark write as complete.
   * Called by runtime when tool execution completes.
   */
  completeWrite(callId: string): void {
    this.inFlightWrites.delete(callId);
  }

  /**
   * Compute effective permissions: original auth ∩ host phase ∩ current role.
   */
  private computeEffectivePermissions(): EffectivePermissions {
    const original = this.context.originalAuth;
    const hostPhase = this.context.hostPhaseAuth;
    const role = this.context.roleAuth;

    // Intersection: only tools in all three sets.
    const effective = new Set<string>();
    for (const tool of original) {
      if (hostPhase.has(tool) && role.has(tool)) {
        effective.add(tool);
      }
    }

    return {
      originalAuth: original,
      hostPhaseAuth: hostPhase,
      roleAuth: role,
      effective,
    };
  }
}

/**
 * Create adapter instance with context.
 */
export function createTrajectoryHandoffAdapter(
  context: AdapterContext
): TrajectoryHandoffAdapter {
  return new TrajectoryHandoffAdapterImpl(context);
}

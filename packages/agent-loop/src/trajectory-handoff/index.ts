/**
 * Trajectory Handoff v2.3 - Public API
 *
 * Exports all kernel components: state machine, types, adapter, and recovery.
 */

// State machine
export type { StateTransitionError } from './state-machine.js';
export {
  transitionHandoff,
  listHandoffTransitions,
  isTerminal,
  isSuspended,
  getTerminalStates,
  leadsToTerminal,
} from './state-machine.js';

// Type definitions
export type {
  HandoffRuntimeState,
  HandoffTerminalState,
  HandoffRuntimeNonTerminal,
  HandoffTransitionEvent,
  PlanObject,
  PlanStep,
  CapabilityTier,
  CapabilityTiersConfig,
  EffectivePermissions,
  TrajectoryHandoffKernel,
  TrajectoryHandoffAdapter,
  HandoffStateEvent,
  HandoffCountingContext,
  CoordinatorRefillDecision,
  PlanConflictContext,
  ModelResolutionContext,
} from './types.js';
export {
  isTerminalState,
  isSuspendState,
} from './types.js';

// Adapter
export type { AdapterContext } from './adapter.js';
export { TrajectoryHandoffAdapterImpl, createTrajectoryHandoffAdapter } from './adapter.js';

// Persistence & Crash Recovery (Codex R1/R2)
export type {
  PersistedCallIntent,
  PersistedCallResult,
  PersistedHandoffState,
  ReconciliationContext,
  ReconciliationResult,
} from './recovery.js';
export {
  checkDeadlineR1,
  reconcileCallBudgetR2,
  recoverFromCrash,
} from './recovery.js';

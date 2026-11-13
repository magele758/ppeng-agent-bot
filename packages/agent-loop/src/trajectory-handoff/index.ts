/**
 * Trajectory Handoff v2.3 - Public API
 *
 * Exports kernel state machine, types, adapter, and recovery components.
 */

// State machine
export {
  applyTransition,
  checkHandoffCap,
  isTerminal,
  isSuspended,
  isActive,
  createInitialKernelState,
  resetTurnCounter,
  listAllTransitions,
  ALL_STATES,
  ALL_EVENTS,
} from './state-machine.js';

// Type definitions
export type {
  HandoffState,
  HandoffActiveState,
  HandoffSuspendState,
  HandoffTerminalState,
  HandoffEvent,
  HandoffKernelState,
  HandoffCounters,
  PlanObject,
  PlanStep,
  PlanStatus,
  CapabilityTiersConfig,
  CapabilityTierRoles,
  HandoffCapConfig,
  ResolvedCapabilityTiers,
  HandoffEventSink,
  PlanStore,
  ModelResolver,
  CoordinatorResumeEvent,
  CallReservation,
  ReconcileResult,
} from './types.js';

export { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';


// State machine transition types
export type {
  TransitionResult,
  TransitionOk,
  TransitionErr,
  CapCheckResult,
} from './state-machine.js';

// Config parser
export type {
  ParseConfigResult,
  ParseConfigError,
  ParseConfigOutput,
} from './config.js';

export {
  parseCapabilityTiers,
  parseCapabilityTiersOrNull,
} from './config.js';
// Recovery
export type {
  DeadlineCheckInput,
  DeadlineCheckResult,
  RuntimeBillingInput,
  RuntimeBillingResult,
} from './recovery.js';
export {
  checkDeadline,
  createCallReservation,
  markReservationCommitted,
  markReservationUnknown,
  reconcileReservation,
  reconcileAllReservations,
  billConservativeRuntime,
} from './recovery.js';

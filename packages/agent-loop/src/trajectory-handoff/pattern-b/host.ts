/**
 * Dedicated Pattern B module for the Swarm host.
 * Not exported from the trajectory-handoff barrels.
 */
export { admitWorkerWrite, boundaryFromLifecycle } from './boundary.js';
export {
  createFileIntegrationStore,
  createMemoryIntegrationStore,
  logicalIntegrationKey,
} from './integration-store.js';
export type {
  AuthorizeInput,
  BindingProof,
  IntegrationEffects,
  IntegrationStore,
  StoreResult,
} from './integration-store.js';
export { createFileLifecycleStore, createMemoryLifecycleStore } from './lifecycle.js';
export type { CreateWorkspaceInput, LifecycleStore } from './lifecycle.js';
export {
  clearHostBoundaries,
  clearHostBoundary,
  hostBoundaryKey,
  installHostBoundary,
  readHostBoundary,
} from './host-registry.js';
export { canonicalPath, pathContained } from './paths.js';
export { denyPatternBTool, patternBBlockedCalls, patternBBoundaryPending } from './tool-gate.js';
export type { PatternBCall } from './tool-gate.js';
export { PATTERN_B_PRODUCTION_ENTRY } from './types.js';
export type {
  BoundaryDecision,
  BoundaryRegistry,
  IntegrationRecord,
  PatternBRole,
  ReadOnlyMount,
  SharedTargetRef,
  WorkerIdentity,
  WritableBoundary,
  WriteAdmission,
} from './types.js';

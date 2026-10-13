/**
 * Session utilities re-exports.
 */

export { calculateSessionBudget, resolveMaxContextTokens, resolveHistoryTokenBudget } from './session-budget.js';
export type { SessionBudget, SessionBudgetInput } from './session-budget.js';

export {
  microCompactMessages,
  microCompactConfigFromEnv,
  toolResultPlaceholder,
  assistantFollowsToolResult,
  formatToolResultStub,
  isToolResultStub,
  parseToolResultStubRef,
  TOOL_RESULT_STUB_MARK,
  DEFAULT_MICRO_COMPACT_CONFIG
} from './micro-compact.js';
export type {
  MicroCompactConfig,
  MicroCompactPolicy,
  MicroCompactStats,
  ToolResultStubAddr,
  ToolResultStubRef
} from './micro-compact.js';

export {
  buildRunOutcome,
  runOutcomeFromEnd,
  parseRunOutcome,
  mergeOutcomeMetadata,
  RUN_OUTCOME_METADATA_KEY
} from './run-outcome.js';
export type {
  RunOutcome,
  RunOutcomeKind,
  RunOutcomeRewind,
  FailureStage
} from './run-outcome.js';

export {
  foldSurface,
  foldCanonicalJson,
  unmatchedToolCallIds,
  isToolWaveOpen,
  parseSurfaceOp,
  shadowedSeqs,
  surfaceNodeToMessage,
  assertSeqStrictlyIncreasing,
  assertReplaceRangeCovered,
  assertReplaceRangeClosed,
  assertNoOpenToolWaveForCompact,
  SurfaceInvariantError
} from './surface-invariants.js';
export type { SurfaceOp, SurfaceNode } from './surface-invariants.js';

export type {
  SessionSurfaceStore,
  SessionSurfaceStoreExt,
  SurfaceReplacementInput,
  SurfaceReplaceInput,
  SurfaceWriteOpts
} from './surface-store.js';
export { createMemorySurfaceStore, MemorySurfaceStore } from './surface-store.js';

export {
  createWaitingApprovalInterrupt,
  decideInterruptResume,
  parseRunInterrupt,
  mergeInterruptMetadata,
  unmatchedToolCallsFromFold,
  INTERRUPT_METADATA_KEY
} from './interrupt.js';
export type { RunInterruptState, InterruptResumeAction } from './interrupt.js';

export {
  DEFAULT_STEER_INTERRUPT_POLICY,
  parseSteerInterruptPolicy,
  resolveSteerInterruptPolicy
} from './steer-interrupt.js';
export type { SteerInterruptPolicy } from './steer-interrupt.js';

export { decideSteerAdmission, steerAckToHttp, isSessionEndedStatus, isCompactInFlight } from './steer-ack.js';
export type { SteerAck, SteerAckStatus, HttpSteerAck, HttpSteerAckStatus, NotSubmittedReason } from './steer-ack.js';

export {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  resolveSteerInboxTarget,
  parseSteerDrainPolicy,
  AGENT_LOOP_SETTINGS_KEY,
  DEFAULT_STEER_DRAIN_POLICY
} from './steer-drain.js';
export type {
  SteerDrainPolicy,
  AgentLoopSettings,
  SteerDrainSettingsStore,
  SteerDrainClaimStore,
  DrainSteerAtToolLaunchResult
} from './steer-drain.js';

export { WriterClaimError, assertWriterClaim } from './writer-claim.js';

export {
  parseConfidenceFromText,
  formatSubagentSummary,
  resolveSubagentAgentId,
} from './subagent-contract.js';
export type { SubagentSpawnArgs, SubagentSummary } from './subagent-contract.js';

export {
  STEERING_CHILDREN_KEY,
  parseSteeringChildren,
  mergeSteeringChild,
  formatSteeringSubagentResult,
  trackSteeringWait,
  waitSteeringChildrenIdle,
  hasPendingSteeringChildren,
  startSteeringSubagent,
} from './steering-subagent.js';
export type { SteeringChildRef, SteeringSpawnFn } from './steering-subagent.js';

export {
  WORKING_LOG_FILENAME,
  appendWorkingLogEntry,
  readWorkingLogTail,
  workingLogEnabled,
  workingLogPath,
  workingLogTailChars,
} from './working-log.js';
export type { WorkingLogEntry, WorkingLogEntryKind } from './working-log.js';

export {
  compensateCompletedLifo,
  createCompensationTx,
  runWithCompensation,
  registerToolCompensation,
} from './compensation.js';
export {
  runAutoCompact,
  selectCompactableClosedRange,
  isContextOverflowError,
  findPrunableToolResult,
  COMPACT_KEEP_RECENT,
} from './auto-compact.js';
export type { AutoCompactStore, AutoCompactResult, RunAutoCompactInput } from './auto-compact.js';
export {
  SessionEventLog,
  createEphemeralEventLog,
  hydrateEventLog,
  lastClosedStepSeq,
  lastRunStartSeq,
  uncommittedRewindAnchorSeq,
} from './event-log.js';
export {
  beginEventLogRun,
  beginEventLogStep,
  commitEventLogStep,
  retractEventLogUncommitted,
  endEventLogRun,
  createEventLogStepTx,
} from './event-log-saga.js';
export {
  compileContextPack,
  compileAppendixFromSources,
  formatCompiledContextPack,
  MEMORY_CONTEXT_APPENDIX_PREFIX,
} from './context-compiler.js';

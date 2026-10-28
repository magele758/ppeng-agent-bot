/**
 * L1/L2 public barrel: WAL surface + inbox / compact / budget.
 * Import from `@ppeng/agent-core/session`.
 */

export type {
  SessionSurfaceStore,
  SessionSurfaceStoreExt,
  SurfaceReplacementInput,
  SurfaceReplaceInput,
  SurfaceWriteOpts
} from './surface-store.js';
export { createMemorySurfaceStore, MemorySurfaceStore } from './surface-store.js';
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
export { runAutoCompact, isContextOverflowError, COMPACT_KEEP_RECENT } from './auto-compact.js';
export type { AutoCompactStore, AutoCompactResult } from './auto-compact.js';
export { StepInboxStore } from './step-inbox.js';
export type { InboxItem, InboxTarget, InboxRole, EnqueueSteerOptions } from './step-inbox.js';
export {
  applyInboxOverflow,
  parseInboxOverflowCap,
  planInboxOverflow,
  resolveInboxOverflowCap,
  summarizeInboxOverflow,
  DEFAULT_INBOX_OVERFLOW_CAP,
  INBOX_OVERFLOW_KEY,
  INBOX_OVERFLOW_PREFIX,
  SUGGESTED_INBOX_OVERFLOW_CAP
} from './inbox-overflow.js';
export {
  microCompactMessages,
  microCompactConfigFromEnv,
  toolResultPlaceholder,
  assistantFollowsToolResult,
  formatToolResultStub,
  isToolResultStub,
  parseToolResultStubRef,
  TOOL_RESULT_STUB_MARK
} from './micro-compact.js';
export type {
  MicroCompactConfig,
  MicroCompactPolicy,
  MicroCompactStats,
  ToolResultStubAddr,
  ToolResultStubRef
} from './micro-compact.js';
export { buildSessionModelView } from './model-view.js';
export type { SessionModelView } from './model-view.js';
export {
  assembleContextStack,
  describeContextBudget,
  previewSessionContextStack
} from './context-stack.js';
export {
  orderContextSnapshots,
  parseContextSnapshotBlocks,
  preparedContextSnapshotBlocks,
  preparedContextSnapshotBlocksFor,
  recordPreparedContextSnapshot,
  selectContextSnapshot
} from './context-snapshots.js';
export type { ContextSnapshot, ContextSnapshotBlock } from './context-snapshots.js';
export type {
  ContextAppendixView,
  ContextBlockDisposition,
  ContextBlockKind,
  ContextStackBlock,
  ContextStackBudget,
  ContextStackPayload,
  ContextStackPreviewHost
} from './context-stack.js';
export {
  retrieveSessionToolResult,
  retrieveStoredToolResult,
  resolveToolResultLookup,
  storedToolResultToJson
} from './tool-result-retrieve.js';
export type {
  StoredToolResult,
  ToolResultLookup,
  ToolResultRetrieveStore
} from './tool-result-retrieve.js';
export {
  COMPACT_SETTINGS_KEY,
  COMPACT_POLICIES,
  defaultCompactSettings,
  hasPersistedCompactSettings,
  normalizeCompactSettings,
  parseCompactPolicy,
  parseKeepRecent,
  readCompactSettings,
  resolveMicroCompactConfig,
  writeCompactSettings
} from './compact-settings.js';
export type { CompactSettings, CompactSettingsPatch, CompactSettingsStore } from './compact-settings.js';

export {
  assertCompactInvariant,
  assertRepeatGuardInvariant,
  assertStablePrefixInvariant,
  assertStartupInvariants,
  hashStablePrefix,
  parseStartupRepeatGuardMode,
  stablePrefixHashOf,
  stablePrefixIdentitySegment,
  StartupInvariantError
} from './startup-invariants.js';
export type {
  CompactInvariant,
  RepeatGuardInvariant,
  StablePrefixIdentity,
  StablePrefixInvariant,
  StartupCompactPolicy,
  StartupCompactSettings,
  StartupInvariantLog,
  StartupInvariantStore,
  StartupInvariants,
  StartupRepeatGuardMode
} from './startup-invariants.js';
export {
  INPUT_SUGGESTION_SETTINGS_KEY,
  INPUT_SUGGESTION_MAX,
  acceptSuggestionResponse,
  defaultInputSuggestionSettings,
  hasPersistedInputSuggestionSettings,
  inputSuggestionRequest,
  normalizeInputSuggestionSettings,
  parseInputSuggestion,
  readInputSuggestionSettings,
  recentSuggestionTurns,
  suggestionPrompt,
  suggestionVisible,
  writeInputSuggestionSettings
} from './input-suggestion.js';
export type {
  InputSuggestion,
  InputSuggestionSettings,
  InputSuggestionSettingsPatch,
  InputSuggestionSettingsStore,
  SuggestionTurn
} from './input-suggestion.js';
export { resolveHistoryTokenBudget } from './session-budget.js';
export { decideSteerAdmission, steerAckToHttp, sessionSteersImmediately } from './steer-ack.js';
export type { SteerAck, SteerAckStatus, HttpSteerAck } from './steer-ack.js';
export {
  DEFAULT_STEER_INTERRUPT_POLICY,
  parseSteerInterruptPolicy,
  resolveSteerInterruptPolicy
} from './steer-interrupt.js';
export type { SteerInterruptPolicy } from './steer-interrupt.js';
export { runOutcomeFromEnd, parseRunOutcome, mergeOutcomeMetadata } from './run-outcome.js';
export type { RunOutcome, RunOutcomeKind, RunOutcomeRewind, FailureStage } from './run-outcome.js';
export {
  saveStepCheckpoint,
  rewindUncommittedTail,
  latestCheckpoint,
  parseCheckpoints,
  isClosedBoundary,
  CHECKPOINTS_METADATA_KEY
} from './checkpoint.js';
export type { StepCheckpoint, CheckpointResult, RewindResult } from './checkpoint.js';
export { forkSession, assertCanFork, forkRejectToError, resolveForkEndSeq } from './session-fork.js';
export type { ForkSessionResult, SessionForkReject } from './session-fork.js';
export {
  createCompensationTx,
  runWithCompensation,
  registerToolCompensation,
  compensateCompletedLifo
} from './compensation.js';
export { attachFileCompensation } from './file-compensation.js';
export {
  startSteeringSubagent,
  waitSteeringChildrenIdle,
  parseSteeringChildren,
  mergeSteeringChild,
  formatSteeringSubagentResult,
  STEERING_CHILDREN_KEY
} from './steering-subagent.js';
export { decideAutoFork, isAutoForkUsed, AUTO_FORK_USED_KEY } from './auto-fork.js';
export type { AutoForkDecision, AutoForkTrigger } from './auto-fork.js';
export {
  createWaitingApprovalInterrupt,
  decideInterruptResume,
  parseRunInterrupt,
  mergeInterruptMetadata,
  unmatchedToolCallsFromFold,
  selectExecutableToolCalls
} from './interrupt.js';
export type { RunInterruptState } from './interrupt.js';
export { assertWriterClaim, WriterClaimError } from './writer-claim.js';
export { closeOpenToolWave } from './tool-wave-close.js';
export {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  AGENT_LOOP_SETTINGS_KEY
} from './steer-drain.js';
export type { SteerDrainPolicy } from './steer-drain.js';
export {
  SessionEventLog,
  createEphemeralEventLog,
  hydrateEventLog,
  foldEventLogSurface,
  lastClosedStepSeq,
  uncommittedRewindAnchorSeq,
  isSurfaceEventType,
  isClosedBoundaryType
} from './event-log.js';
export type {
  EventLogType,
  EventLogEvent,
  EventLogCheckpoint,
  EventLogRetractResult,
  PersistedEventLog
} from './event-log.js';
export {
  EVENT_LOG_METADATA_KEY,
  beginEventLogRun,
  beginEventLogStep,
  commitEventLogStep,
  retractEventLogUncommitted,
  endEventLogRun,
  getSessionEventLog,
  loadEventLog,
  persistEventLog
} from './event-log-saga.js';
export {
  EVENT_LOG_SETTINGS_KEY,
  defaultEventLogSettings,
  readEventLogSettings,
  writeEventLogSettings,
  isEventLogEnabled,
  hasPersistedEventLogSettings
} from './event-log-settings.js';
export type { EventLogSettings, EventLogSettingsPatch } from './event-log-settings.js';
export {
  buildTrajectorySnapshot,
  parseTrajectoryQuery,
  parseOptionalSafeInt
} from './trajectory.js';
export type {
  TrajectorySnapshot,
  TrajectoryTurn,
  TrajectoryRecord,
  TrajectoryQuery
} from './trajectory.js';
export {
  compileContextPack,
  compileTurnAppendix,
  compileTurnAppendixAsync,
  formatCompiledContextPack,
  lastUserQueryFromMessages,
  previewContextPack,
  previewContextPackAsync
} from './context-compiler.js';
export {
  formatWrittenAt,
  resolveConversationTimezone,
  zonedClock
} from './conversation-clock.js';
export type { CompileTurnAppendixInput } from './context-compiler.js';

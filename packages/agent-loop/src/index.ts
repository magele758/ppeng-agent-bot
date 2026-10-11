/**
 * @ppeng/agent-loop
 *
 * Embeddable agent loop core: turn kernel, model adapters, streaming watchdogs,
 * loop guards, session state, and tool execution.
 *
 * This module is also the type SSOT for the loop layer — consumers re-export
 * from here rather than redeclaring session/message/tool shapes.
 */

// L0: Types
export type {
  AgentSpec,
  ApprovalMode,
  ApprovalRecord,
  ApprovalStatus,
  BackgroundJobRecord,
  BackgroundJobStatus,
  HttpProblemDetails,
  ImagePart,
  ImageRetentionTier,
  MailRecord,
  MailStatus,
  MessagePart,
  MessageRole,
  ModelAdapter,
  ModelStreamChunk,
  StreamResetReason,
  ModelTurnInput,
  ModelTurnResult,
  ReasoningPart,
  RunContext,
  SessionMemoryEntry,
  SessionMessage,
  SessionMode,
  SessionRecord,
  SessionStatus,
  SideEffectLevel,
  SummaryInput,
  SurfaceUpdatePart,
  TaskArtifact,
  TaskRecord,
  TaskStatus,
  TextCompletionInput,
  TextPart,
  TodoItem,
  TokenUsage,
  ToolCallPart,
  ToolContract,
  ToolExecutionResult,
  ToolResultPart,
  TraceEvent,
  TraceEventKind,
  WorkspaceMode,
  WorkspaceRecord,
} from './types.js';

// L1: Helpers
export { createId, envBool, envInt, nowIso } from './helpers.js';

// L1: Session
export type { SessionBudget, SessionBudgetInput } from './session/index.js';
export { calculateSessionBudget, resolveMaxContextTokens } from './session/index.js';

// L1: Streaming
export {
  classifyAssistantParts,
  detectRepetitionLoop,
  isRepetitionAbort,
  loadReasoningSpinWatchdogConfig,
  loadRepetitionWatchdogConfig,
  ReasoningSpinWatchdog,
  reasoningSpinWatchdogEnabled,
  RepetitionLoopAbortError,
  repetitionWatchdogEnabled,
  RepetitionStreamGuard,
  createStreamResetTracker,
} from './streaming/index.js';
export type {
  ModelResponseKind,
  ReasoningSpinWatchdogConfig,
  RepetitionWatchdogConfig,
  StreamResetTracker,
} from './streaming/index.js';

// L1: Recovery
export { findSimilarToolName, recoveryPolicyEnabled, SessionLoopGuard } from './recovery/index.js';
export type { LoopGuardToolCall } from './recovery/index.js';

export {
  AUTO_FORK_USED_KEY,
  decideAutoFork,
  isAutoForkUsed,
} from './recovery/auto-fork.js';
export type {
  AutoForkCheckpoint,
  AutoForkDecision,
} from './recovery/auto-fork.js';

export {
  UNPAIRED_TOOL_RESULT_CONTENT,
  ensureFoldToolCallsPaired,
  pairUnmatchedToolCalls,
  syntheticUnpairedToolResultParts,
  unmatchedToolCallsFromMessages,
} from './recovery/pair-unmatched-tool-calls.js';
export type {
  FoldPairableStore,
  PairUnmatchedToolCallsResult,
  UnmatchedToolCall,
} from './recovery/pair-unmatched-tool-calls.js';

export {
  buildSyntheticBehaviorResult,
  isToolAvailabilityError,
  recoverFromModelBehavior,
} from './recovery/model-behavior-recovery.js';
export type {
  PendingToolCall,
  RecoverFromModelBehaviorInput,
  RecoverFromModelBehaviorResult,
  SyntheticBehaviorResult,
} from './recovery/model-behavior-recovery.js';

export {
  AdvisoryGrace,
  advisoryGraceEnabled,
  advisoryGraceBudget,
  formatRecoveryAdvisory,
} from './recovery/advisory-grace.js';
export type { GraceOutcome, GuardDecision } from './recovery/advisory-grace.js';

export { AdvisoryQueue } from './recovery/advisory-queue.js';
export type { AdvisoryDraft } from './recovery/advisory-queue.js';

export {
  RiskEngine,
  formatRiskAdvisory,
  DEFAULT_RISK_CONFIG,
  riskEngineConfigFromEnv,
  riskEngineEnabled,
} from './recovery/risk-engine.js';
export type {
  RiskEngineConfig,
  RiskSignalType,
  RiskSnapshot,
  RiskTickResult,
} from './recovery/risk-engine.js';
export { buildUnknownToolResultContent } from './recovery/unknown-tool-result.js';
export type { UnknownToolResultPayload } from './recovery/unknown-tool-result.js';

// L3: Turn Host Interface
export type {
  AgentStepEvent,
  AutoForkHostInput,
  AutoForkTrigger,
  CheckToolApprovalsExtras,
  HitlLatchDecision,
  KernelRunInfo,
  KernelStepInfo,
  KernelStepKind,
  KernelStepTx,
  PromptContext,
  ResolveTurnToolsResult,
  RunTurnKernelInput,
  ToolExecResult,
  TurnKernelHost,
  TurnKernelPrompt,
  TurnKernelStore,
} from './turn/host.js';
export { DEFAULT_LOOP_CONFIG, LAST_TURN_FALLBACK, LAST_TURN_NUDGE, resolveLoopConfig, resolveTurnCap } from './turn/config.js';
export type { LoopConfig, ResolvedLoopConfig } from './turn/config.js';
export { createKernelHookRegistry, registerKernelHooks } from './turn/hooks.js';
export type { KernelHookListener, KernelHookRegistry } from './turn/hooks.js';
export {
  applyMemoryAppendixToMessages,
  lastUserQueryFromMessages,
  prepareTurnInput,
} from './turn/prepare-turn-input.js';
export type {
  PreparedTurnInput,
  PrepareTurnInputDeps,
  PrepareTurnInputStore,
} from './turn/prepare-turn-input.js';
export { defaultPrepareView } from './turn/default-view.js';
export type { DefaultPrepareViewOptions } from './turn/default-view.js';
// L2: Turn Recovery
export {
  createTurnRecoveryState,
  decideTurnRecovery,
  discardedAssistant,
  finishAskedForTools,
  hasAssistantText,
  hasIncompleteToolCalls,
  noteCriticalHit,
  TOOL_CALL_LEAK_PATTERNS,
  TOOL_CALL_LEAK_RE,
  toolCallParts,
} from './turn/turn-recovery.js';
export type { DecideTurnRecoveryInput, RecoveryAction, TurnRecoveryState } from './turn/turn-recovery.js';

// L8: Turn Kernel
export { runSessionKernel } from './turn/kernel.js';
export type { AgentLoopLatch, TurnKernelOptions } from './turn/kernel.js';
export { clampFoldToVisible, MAX_VISIBLE_MESSAGES } from './session/fold-budget.js';
export type { ClampFoldOptions } from './session/fold-budget.js';


// L2: Model — adapters
export {
  OpenAICompatibleAdapter,
  OpenAiChatAdapter,
  OpenAiResponsesAdapter,
  AnthropicMessagesAdapter,
} from './model/model-adapters.js';
export type {
  OpenAICompatibleAdapterOptions,
  OpenAiChatAdapterOptions,
  OpenAiResponsesAdapterOptions,
  AnthropicMessagesAdapterOptions,
} from './model/model-adapters.js';

// L2: Model — typed upstream failures (status / Retry-After for retry policy)
export {
  UpstreamHttpError,
  UpstreamStreamError,
  parseRetryAfterMs,
  retryAfterMsOf,
} from './model/upstream-error.js';

// L2: Model — utilities
export {
  isTruncatedFinish,
  mergeUsage,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  splitCumulativePromptTokens,
} from './model/usage.js';

export {
  DEFAULT_MODEL_PRICES,
  estimateUsageCostUsd,
  mergeCostUsd,
  resolveModelPrice,
} from './model/token-cost.js';
export type { CostEstimate, TokenPricePerMillion } from './model/token-cost.js';

export {
  llmPromptDebugEnabled,
  maybeLogLlmRequest,
  sanitizeLlmRequestBodyForDebug,
} from './model/llm-prompt-debug.js';

export { parseModelToolArguments } from './model/parse-tool-arguments.js';

export {
  applyRefusalPreservationGuard,
  buildRefusalPreservationReminder,
  detectRefusalRedirectPattern,
  isRedirectAttempt,
  isRefusalMessage,
} from './model/refusal-preservation.js';
export type { RefusalPreservationResult } from './model/refusal-preservation.js';

export {
  formatRemoteEnvInspection,
  inspectRemoteEnv,
  normalizeRemoteSecret,
} from './model/remote-env.js';
export type { RemoteEnvInspection } from './model/remote-env.js';

export {
  normalizeUpstreamRequestId,
  pickUpstreamRequestIdFromHeaders,
  pickUpstreamRequestIdFromJsonText,
  pickUpstreamRequestIdFromRecord,
  resolveUpstreamRequestId,
  unwrapNestedUpstreamError,
  wrapResponseToCaptureUpstreamRequestId,
} from './model/upstream-request-id.js';
export type { HeaderGetter, NestedUpstreamError } from './model/upstream-request-id.js';
// L2: Tools
export {
  checkShellPolicy,
  countCodeSearchRuns,
  countCompletedToolRuns,
  countDirectoryBrowseRuns,
  countSimilarSearchRuns,
  DEFAULT_SHELL_POLICY_CONFIG,
  isCodeSearchCommand,
  isDirectoryBrowseCommand,
  isGuiLaunchCommand,
  isUnboundedFsWalk,
  searchKeywords,
  searchesAreSimilar,
  shellHistoryFromFold,
  shellPolicyBlock,
  toolCallSignature,
} from './tools/shell-policy.js';
export type { HistoryEntry, PolicyDecision, ShellPolicyConfig } from './tools/shell-policy.js';

export {
  DEFAULT_ARCHIVE_THRESHOLD,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_SKIP_TOOLS,
  formatToolArchivePreview,
  interceptToolOutput,
} from './tools/tool-result-guardian.js';
export type { ArtifactManifest, ArtifactStore, InterceptResult } from './tools/tool-result-guardian.js';

// L7: Runtime - Tool Loop
export {
  checkToolApprovals,
  executeToolCalls,
  executeSingleTool,
  filterValidToolCalls,
  processToolResults,
  retryDelayMs,
  runTurnWithRetries,
  MAX_RETRY_AFTER_MS,
} from './runtime/tool-loop.js';
export type {
  CompletedWaveItem,
  FileApprovalPolicy,
  ToolLoopHost,
  ToolLoopResult,
  ToolTaskRecord,
} from './runtime/tool-loop.js';

// L2: Model — stop reason classification
export { isToolUseFinish, resolveModelStopReason } from './model/stop-reason.js';
export type { ModelStopReason } from './model/stop-reason.js';

// L2: Model — tool result problem (RFC 9457)
export { toolInfraProblem, formatToolResultForLlm, TOOL_INFRA_PROBLEM_TYPE } from './model/tool-result-problem.js';

// L7: Runtime — RunProfile (TaskMode × skill_scope)
export {
  applyRunProfileToTools,
  applyUnboundTaskModePatch,
  BROWSER_TOOLS,
  COMPUTER_USE_TOOLS,
  DYNAMIC_WORKFLOW_CONVERGENCE_MAX_ROUNDS,
  DYNAMIC_WORKFLOW_WORKER_CONCURRENCY_CAP,
  FAST_MODE_TOOL_ALLOWLIST,
  filterSkillsByScope,
  isBrowserTool,
  isComputerUseTool,
  isResearchTool,
  isTaskRunModeBound,
  orchestrationReplayFromMetadata,
  parseOrchestrationReplay,
  parseSkillScope,
  parseTaskMode,
  PERSISTENT_MEMORY_TOOLS,
  PLAN_PROTOCOL_TOOLS,
  PLANNER_READONLY_TOOLS,
  PTC_TOOLS,
  requestedSkillNames,
  RESEARCH_TOOLS,
  resolveOrchestrationEngine,
  resolveRunProfile,
  runProfileFromSession,
  sealTaskRunModePatch,
  SKILL_SCOPES,
  TASK_MODES,
  TASK_RUN_MODE_BOUND_KEY,
  TEAMS_TOOLS,
  taskModeFromMetadata,
  visibleToolNames,
  skillScopeFromMetadata,
} from './runtime/run-profile.js';
export type {
  OrchestrationEngine,
  OrchestrationKind,
  OrchestrationReplay,
  PersistentMemoryMode,
  PlanProtocol,
  RunProfile,
  SkillScope,
  TaskMode,
  TaskModePatchResult,
  ToolPolicyLayer,
} from './runtime/run-profile.js';

// L1: Session — subagent contract
export {
  parseConfidenceFromText,
  formatSubagentSummary,
  resolveSubagentAgentId,
} from './session/index.js';
export type { SubagentSpawnArgs, SubagentSummary } from './session/index.js';

export {
  createMemoryStepTx,
  rollbackReasonOf,
  turnEndReasonOf,
  uncommittedRewindAnchorSeq,
  wrapWithStepTx,
} from './session/step-tx.js';
export type { MemoryStepTxOpts, StepTxEndInput } from './session/step-tx.js';

export {
  CHECKPOINTS_METADATA_KEY,
  decideRewindTail,
  isCheckpointStore,
  isClosedBoundary,
  lastClosedSeq,
  latestCheckpoint,
  parseCheckpoints,
  rewindUncommittedTail,
  saveStepCheckpoint,
} from './session/checkpoint.js';
export type {
  CheckpointRejection,
  CheckpointResult,
  CheckpointStore,
  RewindResult,
  RewindTailDecision,
  StepCheckpoint,
} from './session/checkpoint.js';

export { applyClaimedInbox, claimAndApplyInbox } from './session/apply-claimed-inbox.js';
export type {
  ApplyClaimedInboxOpts,
  ApplyClaimedInboxStore,
  ClaimedInboxItem,
} from './session/apply-claimed-inbox.js';

export { decideHitlLatch, shouldParkBeforeTools } from './approval/hitl-latch.js';
export type {
  DecideHitlLatchInput,
  HitlApprovalDecision,
  HitlLatchAction,
  HitlLatchResult,
} from './approval/hitl-latch.js';

export { correctWrongStopSignal } from './model/correct-stop-reason.js';
export {
  promoteAssistantReasoning,
  promoteReasoningToTextIfNeeded,
} from './model/promote-reasoning.js';
export { defaultWorkspaceRoots } from './workspace/default-roots.js';
export type { WorkspaceRootSpec } from './workspace/default-roots.js';

// L1: Session — steering subagent
export {
  STEERING_CHILDREN_KEY,
  parseSteeringChildren,
  mergeSteeringChild,
  formatSteeringSubagentResult,
  trackSteeringWait,
  waitSteeringChildrenIdle,
  hasPendingSteeringChildren,
  startSteeringSubagent,
} from './session/index.js';
export type { SteeringChildRef, SteeringSpawnFn } from './session/index.js';

// L1: Goal — soft completion gate (pure logic; no I/O)
export {
  GOAL_CONDITION_META,
  GOAL_ENABLED_META,
  GOAL_LEDGER_META,
  GOAL_MAX_TURNS_META,
  GOAL_TURNS_USED_META,
  GOAL_EVENTS,
  GOAL_STATUSES,
  GOAL_SETTINGS_KEY,
  closeReasonForEvent,
  createGoalGateFromMetadata,
  createGoalRecord,
  decideGoalTurn,
  decisionToGoalEvent,
  defaultGoalMaxTurns,
  defaultGoalSettings,
  describeGoalVerifySpec,
  goalGateEnabled,
  GoalGate,
  GoalStore,
  isExecutableVerifySpec,
  isSafeRelPath,
  listGoalTransitions,
  normalizeGoalSettings,
  parseGoalEvalJson,
  parseGoalVerifySpec,
  readGoalLedger,
  readGoalSettings,
  resolveGoalCondition,
  sanitizeDerivedVerifySpec,
  transitionGoal,
  trimGoalLedger,
  tryGoalStore,
  upgradeGoalRecord,
  writeGoalSettings,
} from './goal/index.js';
export type {
  GoalCloseReason,
  GoalEvalResult,
  GoalEvalSource,
  GoalJudgeFn,
  GoalLedgerEntry,
  GoalRecord,
  GoalSettings,
  GoalSettingsPatch,
  GoalSettingsStore,
  GoalSpec,
  GoalStatusValue,
  GoalTransitionEvent,
  GoalTurnDecision,
  GoalTurnDecisionInput,
  GoalVerifyKind,
  GoalVerifySpec,
} from './goal/index.js';

// L1: Memory — PTC scratch metadata (pure; no I/O)
export {
  decodePtcStoredValue,
  encodePersistedPtcValue,
  encodePtcStoredValue,
  isPtcAppendixEligible,
  isPtcScratchKey,
  isPtcValueExpired,
  ptcBareKey,
  ptcStoredKey,
  scratchKeyFilterFromInherit,
} from './memory/index.js';
export type { PtcStoredMeta } from './memory/index.js';
// L5: Programmatic Tool Composition (dynamic_workflow)
export * from './ptc/index.js';

// L4: AgentLoop SDK (attachable latch). AgentLoopLatch *type* stays the kernel
// `{ emit }` port above; the parking class is used by createAgentLoop.
export { createAgentLoop, AgentLoopHandle, createAgentLoopFromKernelHost } from './runtime/agent-loop.js';
export type { AgentLoopHost, AgentLoopAttachHost } from './runtime/agent-loop.js';

export {
  createAssembledLoop,
  createMiniAssembledLoop,
  createNormalAssembledLoop,
  LOOP_MODULES,
  LOOP_PRESETS,
  isLoopPreset,
  moduleIdsForPreset,
  parseLoopPreset,
  presetAtLeast,
} from './assembly/index.js';
export type {
  AssembledLoop,
  AssembledLoopIo,
  CreateAssembledLoopInput,
  LoopModuleMeta,
  LoopPreset,
} from './assembly/index.js';

export { gateDirtyToolInput } from './runtime/dirty-input-gate.js';
export {
  compensateCompletedLifo,
  createCompensationTx,
  getCurrentCompensation,
  runWithCompensation,
  registerToolCompensation,
} from './session/compensation.js';
export type {
  CompensationTx,
  CompensationEntry,
  CompletedWaveItem as CompensationWaveItem,
} from './session/compensation.js';
export {
  SessionEventLog,
  createEphemeralEventLog,
  hydrateEventLog,
  foldEventLogSurface,
  isSurfaceEventType,
  isClosedBoundaryType,
  isEventLogType,
  lastClosedStepSeq,
  lastRunStartSeq,
} from './session/event-log.js';
export type {
  EventLogType,
  EventLogEvent,
  EventLogCheckpoint,
  EventLogCheckpointRejection,
  EventLogCheckpointResult,
  EventLogRetractResult,
  EventLogSurfaceOp,
  PersistedEventLog,
} from './session/event-log.js';
export {
  EVENT_LOG_METADATA_KEY,
  beginEventLogRun,
  beginEventLogStep,
  commitEventLogStep,
  retractEventLogUncommitted,
  endEventLogRun,
  getSessionEventLog,
  loadEventLog,
  persistEventLog,
  createEventLogStepTx,
} from './session/event-log-saga.js';
export type { EventLogPersistStore, EventLogStepInfo } from './session/event-log-saga.js';
export {
  EVENT_LOG_SETTINGS_KEY,
  defaultEventLogSettings,
  hasPersistedEventLogSettings,
  normalizeEventLogSettings,
  readEventLogSettings,
  writeEventLogSettings,
  isEventLogEnabled,
} from './session/event-log-settings.js';
export type {
  EventLogSettings,
  EventLogSettingsPatch,
  EventLogSettingsStore,
} from './session/event-log-settings.js';
export {
  runAutoCompact,
  isContextOverflowError,
  findPrunableToolResult,
  COMPACT_KEEP_RECENT,
  selectClosedPrefixRange,
} from './session/auto-compact.js';
export type { AutoCompactStore, AutoCompactResult, RunAutoCompactInput } from './session/auto-compact.js';
export {
  prepareRichView,
  applyOptionalFoldBudget,
  capRollingSummaryText,
  compactSummaryMaxChars,
  capSessionMap,
  SESSION_CACHE_MAX,
} from './turn/prepare-view.js';
export type { PrepareViewPorts } from './turn/prepare-view.js';
export {
  compileContextPack,
  compileAppendixFromSources,
  formatCompiledContextPack,
  MEMORY_CONTEXT_APPENDIX_PREFIX,
} from './session/context-compiler.js';
export type { CompiledContextPack, RecallSources } from './session/context-compiler.js';

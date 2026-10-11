/**
 * Whitelisted public API of `@ppeng/agent-core`.
 *
 * Embedders should depend on this surface (or on the L0–L4 subpaths
 * `./types` `./session` `./turn` `./loop`). Internal store classes
 * (`SqliteStateStore`, `stores/*`) and sandbox provider implementations
 * are not re-exported — tests import those via deep paths such as
 * `../dist/storage.js`.
 */

// --- primitives ---
export { envInt, envBool } from '../env.js';
export {
  AppError,
  NotFoundError,
  ValidationError,
  PayloadTooLargeError,
  ConflictError,
  AuthorizationError,
  TimeoutError,
  errorMessage,
  httpStatusFromError
} from '../errors.js';
export { createLogger, setLogLevel, resetLogLevel } from '../logger.js';
export type { LogLevel, Logger } from '../logger.js';

// --- L0 types (AgentSpec / ToolContract / SessionMessage / ModelAdapter …) ---
export * from '../types.js';
export type {
  ApiMessagePart,
  ApiChatMessage,
  ApiSessionSummary,
  ApiAgentInfo,
  ApiBotInfo,
  ApiTaskSummary,
  ApiSocialPostScheduleItem,
  ApiApprovalItem,
  ApiMailItem
} from '../api-types.js';
export { filterSessionsByQuery } from '../session-query.js';
export type { SessionSearchable } from '../session-query.js';

// --- L1/L2 session algebra + L3 turn + L4 loop (also `@ppeng/agent-core/{session,turn,loop}`) ---
export * from '../session/index.js';
export * from '../turn/index.js';
export { createAgentLoop, AgentLoopHandle, AgentLoopLatch } from '../loop.js';
export type { AgentLoopHost, AgentStepEvent } from '../loop.js';

// Session symbols daemon already imports but the L2 barrel does not re-export.
export {
  DEFAULT_STEER_DRAIN_POLICY,
  parseSteerDrainPolicy
} from '../session/steer-drain.js';
export type { NotSubmittedReason } from '../session/steer-ack.js';
export { selectClosedPrefixRange } from '../session/auto-compact.js';

// --- L5 host (全家桶) ---
export { RawAgentRuntime } from '../runtime.js';
export type { RuntimeOptions } from '../runtime.js';

// --- Programmatic Tool Composition (dynamic_workflow) ---
export {
  PTC_EXEC_TOOL_NAME,
  createPtcExecTool,
  runPtcCell,
  runPtcProgram,
  clampPtcTimeoutMs,
  PtcIsolateError,
  parseTaskRunMode,
  parsePtcOrchestrationEngine,
  resolvePtcOrchestrationEngine,
  taskRunModeFromSession,
  skillScopeFromSession,
  orchestrationReplayFromSession,
  orchestrationEngineFromSession,
  isPtcSession,
  ptcMetadataPatchFromInput,
  assertLockedRounds,
  runHardReplay,
  PtcReplayError,
  deriveReplayCapability,
  normalizeSavedOrchestration
} from '../ptc/index.js';
export type {
  TaskRunMode,
  PtcOrchestrationEngine,
  PtcExecInput,
  PtcAgentSpec,
  PtcCellResult,
  PtcIsolateErrorCode,
  SavedOrchestration,
  ReplayRound,
  OrchestrationReplay
} from '../ptc/index.js';

export {
  DYN_TOOLS_NAMESPACE,
  DYN_TOOL_SOURCE,
  DYN_TOOL_SETTINGS_KEY,
  SAVE_AS_TOOL_NAME,
  PROPOSE_TOOL_NAME,
  SEARCH_DYN_TOOLS_NAME,
  DYN_TOOL_PROMOTE_APPROVAL,
  DynToolError,
  defaultDynToolSettings,
  hasPersistedDynToolSettings,
  normalizeDynToolSettings,
  readDynToolSettings,
  writeDynToolSettings,
  resolveDynToolsEnabled,
  createDynToolStore,
  createDynToolStoreFromAgentMemory,
  tryCreateDynToolStore,
  annotateRetiredToolParts,
  searchDynTools
} from '../dyn-tools/index.js';
export type {
  DynToolRecord,
  DynToolSettings,
  DynToolSettingsPatch,
  DynToolScope,
  DynToolStatus,
  DynToolKind
} from '../dyn-tools/index.js';

export {
  TASK_MODES,
  SKILL_SCOPES,
  parseTaskMode,
  parseSkillScope,
  parseOrchestrationReplay,
  resolveRunProfile,
  runProfileFromSession,
  applyRunProfileToTools,
  applyUnboundTaskModePatch,
  sealTaskRunModePatch,
  isTaskRunModeBound,
  filterSkillsByScope,
  requestedSkillNames,
  visibleToolNames,
  PLAN_PROTOCOL_TOOLS,
  TEAMS_TOOLS,
  RESEARCH_TOOLS,
  BROWSER_TOOLS,
  COMPUTER_USE_TOOLS,
  FAST_MODE_TOOL_ALLOWLIST
} from '../runtime/run-profile.js';
export type {
  TaskMode,
  SkillScope,
  RunProfile,
  ToolPolicyLayer,
  PersistentMemoryMode
} from '../runtime/run-profile.js';

// --- Domain bundles + builtin personas ---
export { mergeDomainBundles } from '../domain.js';
export type { DomainBundle, MergedDomainBundles } from '../domain.js';
export { builtinAgents } from '../builtin-agents.js';
export {
  builtinSkills,
  loadAllSkills,
  matchSkills,
  loadAgentsDirSkills,
  loadStateDirSkills,
  loadWorkspaceSkills,
  mergeSkillsByName,
  parseSkillFrontmatter
} from '../skills/builtin-skills.js';

// --- Model adapters ---
export {
  createModelAdapterFromEnv,
  HeuristicModelAdapter,
  OpenAICompatibleAdapter,
  AnthropicCompatibleAdapter,
  HybridModelRouterAdapter,
  textSummaryFromParts,
  normalizeOpenAiHttpKind,
  HEURISTIC_LONG_BASH_MARKER,
  HEURISTIC_LONG_BASH_COMMAND
} from '../model/model-adapters.js';
export type { OpenAiHttpKind } from '../model/model-adapters.js';
export {
  MockLlmProvider,
  createMockLlm,
  mockText,
  mockToolUse,
  mockLlmError,
  turnToResult
} from '../model/mock-llm-provider.js';
export type { MockLlmTurn, MockLlmToolCall, MockLlmScript } from '../model/mock-llm-provider.js';
export {
  checkToolCallPairing,
  checkNoOrphanToolResults,
  checkAssistantToolUseShape,
  checkTranscriptInvariants,
  assertTranscriptInvariants,
  checkGoalTransition,
  checkSessionTransition,
  enumerateGoalMachine,
  transitionSession,
  isLegalSessionTransition,
  listSessionTransitions,
  SESSION_STATUSES,
  SESSION_EVENTS,
  mulberry32,
  pick,
  times
} from '../formal/index.js';
export type { FormalCheck, SessionLifecycleEvent } from '../formal/index.js';
export {
  MODEL_PROVIDERS_KEY,
  HEURISTIC_PROVIDER_ID,
  ENV_FALLBACK_PROVIDER_ID,
  parseProviderKind,
  suggestProviderName,
  parseModelRef,
  modelRefFromSession,
  readSessionModelOverride,
  resolveModelOverrideRef,
  resolveSessionPreferredRef,
  heuristicProvider,
  heuristicRef,
  maskApiKey,
  publicProvider,
  emptyCatalog,
  normalizeCatalog,
  normalizeProvider,
  readModelCatalog,
  writeModelCatalog,
  hasPersistedModelCatalog,
  upsertProvider,
  patchProvider,
  deleteProvider,
  setCatalogDefaultRef,
  patchCatalogRouting,
  mergeScannedModels,
  envFallbackProvider,
  findProvider,
  createAdapterFromProvider,
  createModelAdapterFromEnvOrHeuristic,
  resolveSessionModelAdapter,
  pickerOptions,
  publicCatalogPayload,
  resolveDefaultModelRef,
  mergeModelRefMetadata
} from '../model/provider-catalog.js';
export type {
  ModelProviderKind,
  CatalogModel,
  ModelRef,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderPatch,
  ModelProvidersStore,
  PublicModelProvider,
  ModelPickerOption,
  SessionModelOverride
} from '../model/provider-catalog.js';
export {
  MODEL_FALLBACK_MAX_CHAIN,
  MODEL_FALLBACK_SETTINGS_KEY,
  defaultModelFallbackSettings,
  hasPersistedModelFallbackSettings,
  modelFallbackPayload,
  normalizeModelFallbackSettings,
  planModelFallback,
  readModelFallbackSettings,
  runWithFallbackChain,
  attachServedByToTrace,
  rememberServedBy,
  validateModelFallbackChain,
  writeModelFallbackSettings
} from '../model/fallback-chain.js';
export type {
  FallbackAttempt,
  FallbackCandidate,
  FallbackPlan,
  ModelFallbackEntryStatus,
  ModelFallbackSettings,
  ModelFallbackSettingsPatch,
  ServedBy
} from '../model/fallback-chain.js';
export { classifyModelError } from '../model/error-class.js';
export type { ModelErrorCategory, ModelErrorClassification } from '../model/error-class.js';
export {
  resolveModelRoute,
  resolveRouteCandidates,
  shouldFallbackProviderError,
  withProviderFallback,
  parseThinkingMode
} from '../model/registry-router.js';
export type { ModelRouteResult, ThinkingMode } from '../model/registry-router.js';
export {
  SecretVault,
  createMemorySecretVault,
  bindSecretVault,
  parseSecretRefs,
  runWithSecretRefs,
  currentSecretOverrides,
  assertWritableEnvName,
  isReservedEnvName,
  SECRET_VAULT_KEY,
  SECRET_REFS_METADATA_KEY
} from '../secrets/index.js';
export type { SecretEntrySummary } from '../secrets/index.js';
export {
  parseRemoteModelList,
  listRemoteModels,
  normalizeOpenAiCompatibleBaseUrl,
  baseUrlFromModelsEndpoint
} from '../model/list-models.js';
export type { RemoteModel, ListRemoteModelsResult } from '../model/list-models.js';
export { parseModelToolArguments } from '../model/parse-tool-arguments.js';
export {
  normalizeOpenAiUsage,
  normalizeAnthropicUsage,
  isTruncatedFinish,
  mergeUsage,
  splitCumulativePromptTokens
} from '../model/usage.js';
export {
  pickUpstreamRequestIdFromHeaders,
  unwrapNestedUpstreamError,
  pickUpstreamRequestIdFromRecord,
  pickUpstreamRequestIdFromJsonText,
  wrapResponseToCaptureUpstreamRequestId,
  normalizeUpstreamRequestId,
  resolveUpstreamRequestId
} from '../model/upstream-request-id.js';
export type { HeaderGetter, NestedUpstreamError } from '../model/upstream-request-id.js';
export {
  DEFAULT_MODEL_PRICES,
  resolveModelPrice,
  estimateUsageCostUsd,
  mergeCostUsd
} from '../model/token-cost.js';
export type { TokenPricePerMillion, CostEstimate } from '../model/token-cost.js';
export { estimateTokensFromText, estimateMessageTokens } from '../model/token-estimate.js';

// --- Approval / permission ---
export {
  parseApprovalPolicyFromEnv,
  policyRequiresApproval,
  policySkipsAutoApproval,
  contextHasApprovalPolicy
} from '../approval/approval-policy.js';
export type { ApprovalPolicy, ApprovalPolicyRule } from '../approval/approval-policy.js';
export {
  loadPolicyFromRepo,
  mergeApprovalPolicies,
  filePolicyRequiresBashApproval,
  filePolicyRequiresPathApproval
} from '../approval/policy-loader.js';
export type {
  BashCommandPatternRule,
  PathApprovalRule,
  FileApprovalPolicy
} from '../approval/policy-loader.js';
export {
  parsePermissionMode,
  resolvePermissionMode,
  isReadOnlyTool,
  isEditTool,
  describePermissionMode,
  shiftPermissionMode,
  comparePermissionMode,
  applyPermissionModeGate,
  explainToolUnderMode
} from '../approval/permission-mode.js';
export type { PermissionMode, PermissionModeGate } from '../approval/permission-mode.js';

// --- Skills routing / eval (daemon `/api/eval/skills`) ---
export {
  skillRoutingModeFromEnv,
  skillRoutingTopKFromEnv,
  skillLoadStrictFromEnv,
  skillRoutingFusionFromEnv,
  buildSkillRouting,
  buildSkillRoutingWithFusion,
  buildSkillRoutingWithRobustness,
  buildSkillRoutingWithToolQuality
} from '../skills/skill-router.js';
export {
  SKILL_SETTINGS_KEY,
  SKILL_DISCLOSURE_MODES,
  defaultSkillSettings,
  hasPersistedSkillSettings,
  normalizeSkillSettings,
  parseSkillDisclosureMode,
  readSkillSettings,
  resolveSkillDisclosureMode,
  writeSkillSettings
} from '../skills/skill-settings.js';
export type {
  SkillDisclosureMode,
  SkillSettings,
  SkillSettingsPatch,
  SkillSettingsStore
} from '../skills/skill-settings.js';
export {
  SKILL_PROPOSAL_SETTINGS_KEY,
  SKILL_PROPOSAL_REMIND_MAX,
  SKILL_PROPOSAL_NAME_MAX,
  SKILL_PROPOSAL_DESCRIPTION_MAX,
  SKILL_PROPOSAL_BODY_MAX,
  SKILL_PROPOSAL_MAX_PENDING,
  SKILL_PROPOSE_TOOL_NAME,
  SkillProposalError,
  SkillProposalStore,
  createSkillProposeTool,
  defaultSkillProposalSettings,
  findSecretLikeContent,
  hasPersistedSkillProposalSettings,
  isSkillProposalId,
  isValidSkillProposalName,
  normalizeSkillProposalSettings,
  parseRemindEvery,
  readSkillProposalSettings,
  renderSkillMarkdown,
  resolveSkillProposalsEnabled,
  skillProposalsDir,
  summarizeSkillProposal,
  userSkillsDir,
  validateSkillProposalDraft,
  writeSkillProposalSettings
} from '../skill-proposals/index.js';
export type {
  CreateSkillProposalInput,
  SkillProposalDraft,
  SkillProposalKind,
  SkillProposalRecord,
  SkillProposalSettings,
  SkillProposalSettingsPatch,
  SkillProposalSettingsStore,
  SkillProposalStatus,
  SkillProposalSummary,
  SkillProposeToolDeps
} from '../skill-proposals/index.js';
export type { SkillSearchHit } from '../model/prompt-builder.js';
export type {
  SkillRoutingMode,
  SkillRoutingResult,
  SkillRoutingOptions,
  RobustRoutingOptions,
  ToolAwareRoutingOptions
} from '../skills/skill-router.js';
export {
  tokenize,
  uniqueTokens,
  buildSkillRelationshipCache,
  needsRebuild,
  routeSkillsLexical,
  computeParticleRobustness,
  assessRoutingConfidence,
  assessRoutingConfidenceWithRobustness,
  routeSkillsWithFusion
} from '../skills/skill-matcher.js';
export type {
  SkillRelationship,
  SkillRelationshipCache,
  SkillCycle,
  RoutedSkill,
  RoutingConfidence,
  RoutingConfidenceInfo
} from '../skills/skill-matcher.js';
export {
  DEFAULT_SKILL_EVAL_CASES,
  generateSyntheticTestCases,
  runSkillEval,
  compareSkillEvalModes
} from '../skills/skill-eval.js';
export type {
  SkillEvalTestCase,
  SkillEvalResultCase,
  SkillEvalSummary,
  SkillEvalOptions,
  MultiModeSkillEvalResult
} from '../skills/skill-eval.js';

// --- Storage interfaces + daemon wiring (not SqliteStateStore) ---
export type {
  EventBufferMeta,
  EventBufferEventRow,
  EventBufferAppendInput,
  EventBufferRepository,
  TieredAssetDescriptor,
  AssetStorage,
  SkillCatalogRow,
  SkillRegistryClient
} from '../storage/interfaces.js';
export {
  createProviderConfigFromEnv,
  defaultTenantIdFromEnv,
  defaultUserIdFromEnv,
  validateProviderConfig
} from '../storage/provider-config.js';
export type {
  DeploymentMode,
  SessionStoreProvider,
  EventBufferProvider,
  SkillRegistryProvider,
  AssetStorageProvider,
  DispatchLockProvider,
  ProviderConfig
} from '../storage/provider-config.js';
export { createCoreStorageContext } from '../storage/repository-factory.js';
export type {
  CoreStorageContext,
  CoreStorageOptions,
  StorageFallbacks
} from '../storage/repository-factory.js';

export { connectRedisWithTimeout, createBestEffortRedis } from '../storage/cloud/redis-util.js';
export type { BestEffortRedis } from '../storage/cloud/redis-util.js';

// --- Effective config (config-driven enablement + local fallback) ---
export {
  resolveEffectiveConfig,
  resolveStorage,
  resolveDomainSelection,
  resolveEmbeddingRecall,
  embeddingUpstream,
  parseMemoryEmbeddingMode,
  PG_MIGRATION_HINT
} from '../config/effective-config.js';
export type {
  ConfigSource,
  ConfigGroup,
  ConfigNote,
  EffectiveItem,
  EffectiveConfig,
  EffectiveConfigInput,
  StorageFeature,
  StorageResolution,
  DomainSelection,
  MemoryEmbeddingMode
} from '../config/effective-config.js';

// --- Sandbox public contract (factory + sanitizer; not provider classes) ---
export { sanitizeSpawnEnv, getInjectionVarNames } from '../sandbox/env-sanitizer.js';
export type { SanitizeEnvOptions } from '../sandbox/env-sanitizer.js';
export {
  REDACT_MIN_VALUE_LENGTH,
  collectRedactionTargets,
  redactEnvValues,
  redactToolContent
} from '../sandbox/result-redaction.js';
export type { RedactionTarget } from '../sandbox/result-redaction.js';
export type {
  AgentSandboxKind,
  AgentSandboxExecResult,
  AgentSandboxExecRequest,
  AgentSandbox
} from '../sandbox/agent-sandbox-types.js';
export {
  agentSandboxKindFromEnv,
  createAgentSandboxFromEnv
} from '../sandbox/create-agent-sandbox.js';
export {
  SANDBOX_SETTINGS_KEY,
  SANDBOX_MODES,
  defaultSandboxSettings,
  hasPersistedSandboxSettings,
  normalizeSandboxSettings,
  parseSandboxMode,
  readSandboxSettings,
  resolveSandboxMode,
  resolveCloudflareComputer,
  writeSandboxSettings
} from '../sandbox/sandbox-settings.js';
export type {
  SandboxMode,
  SandboxSettings,
  SandboxSettingsPatch,
  SandboxSettingsStore,
  CloudflareComputerResolved
} from '../sandbox/sandbox-settings.js';

// --- Optional tool groups (daemon `/api` payload) ---
export {
  optionalToolGroupsFeatureEnabled,
  loadOptionalToolGroupsFromEnv,
  optionalToolNamesFromGroups,
  buildOptionalToolGroupsPayload,
  parseDefaultEnabledOptionalGroups,
  mergeEnabledOptionalToolGroups,
  resolveOptionalToolGroups,
  filterToolsByOptionalGroups
} from '../tools/optional-tool-groups.js';
export type {
  OptionalToolGroupItemDef,
  OptionalToolGroupDef,
  OptionalToolGroupsPayload,
  ResolvedOptionalToolGroups
} from '../tools/optional-tool-groups.js';

// --- IM channel kernel + gateway config ---
export { processChannelTurn, parseGenericWebhookInbound } from '../channels/channel-turn.js';
export type {
  ChannelInboundKind,
  ChannelInboundEnvelope,
  ChannelOutboundEnvelope,
  ChannelTurnResult,
  ChannelTurnKernelDeps
} from '../channels/channel-turn.js';
export {
  gatewayConfigPath,
  findGatewayConfigPath,
  loadGatewayChannelIdsSync
} from '../gateway-config-channels.js';

// --- Social schedule (daemon routes use the type; runtime owns delivery) ---
export {
  SOCIAL_POST_SCHEDULE_METADATA_KEY,
  SOCIAL_POST_TASK_KIND,
  BUILTIN_SOCIAL_CHANNELS,
  normalizePublishAtToUtc,
  isValidIsoInstant,
  normalizeSocialChannels,
  validateNormalizedSocialChannels,
  buildSocialPostSchedule,
  readSocialPostSchedule,
  taskTitleForSocialSchedule,
  runSocialPostScheduleDelivery
} from '../social-schedule.js';
export type {
  SocialPostApprovalState,
  SocialPostDispatchState,
  SocialPostChannelDispatch,
  SocialPostScheduleV1,
  BuildSocialScheduleInput,
  SocialScheduleBuildResult,
  SocialPostDeliverFn
} from '../social-schedule.js';

// --- Product subsystems (types + stores used as daemon route APIs) ---
export * from '../discovery/index.js';
export * from '../swarm/index.js';
export * from '../memory/index.js';
export * from '../orchestrator/index.js';
export * from '../deepresearch/index.js';
export * from '../goal/index.js';
export * from '../jev/index.js';
export * from '../langfuse/index.js';
export * from '../workspace/index.js';
export * from '../teams/index.js';
export * from '../a2ui/index.js';
export * from '../bots/index.js';
export { parseSessionMaxTurns } from '../runtime/session-max-turns.js';
export * from '../auth/index.js';
export {
  CronJobStore,
  createCronTools,
  cronToolsFeatureEnabled,
  markCronJobRan,
  nextCronRunAt,
  parseCron5
} from '../cron/index.js';
export type { CronJobRecord, CronScheduleKind, CreateCronJobInput, UpdateCronJobInput, ListCronJobsFilter, RoutinePrecheck } from '../cron/index.js';

// --- Plugins / doctor / extensions ---
export {
  loadPluginFromDir,
  discoverPlugins,
  mergePlugins,
  pluginDirsFromEnv
} from '../plugins/plugin-loader.js';
export type { PluginManifest, LoadedPlugin } from '../plugins/plugin-loader.js';
export * from '../ingestion/index.js';
export * from '../artifact/index.js';
export { createArtifactTools } from '../tools/artifact-tools.js';
export {
  BROWSER_SETTINGS_KEY,
  defaultBrowserSettings,
  hasPersistedBrowserSettings,
  normalizeBrowserSettings,
  readBrowserSettings,
  resolveBrowserToolsEnabled,
  writeBrowserSettings
} from '../tools/browser-settings.js';
export type { BrowserSettings, BrowserSettingsPatch, BrowserSettingsStore } from '../tools/browser-settings.js';
export {
  WEB_SEARCH_NOT_CONFIGURED,
  WEB_SETTINGS_KEY,
  assertSearchUrlTemplate,
  defaultWebSettings,
  hasPersistedWebSettings,
  normalizeWebSettings,
  readWebSettings,
  resolveWebSearchTemplate,
  writeWebSettings
} from '../tools/web-settings.js';
export type { WebSettings, WebSettingsPatch, WebSettingsReadStore, WebSettingsStore } from '../tools/web-settings.js';
export {
  BROWSER_INSTALL_HINT,
  formatBrowserError,
  playwrightBrowserAction,
  probePlaywrightBackend
} from '../tools/browser-backend.js';
export type { BrowserErrorCode, BrowserErrorShape } from '../tools/browser-backend.js';
export { runDoctor, formatDoctorReport } from '../doctor/doctor.js';
export type { DoctorSeverity, DoctorCheck, DoctorReport, DoctorOptions } from '../doctor/doctor.js';
export {
  EVOLUTION_DISABLED_CODE,
  EVOLUTION_SURFACE_ENABLED,
  considerEvolutionSchedule,
  evolutionDisabledBody,
  evolutionStartHttpResult
} from '../evolution/surface.js';
export type { EvolutionScheduleDecision, EvolutionScheduleReason } from '../evolution/surface.js';
export { ExtensionRegistry, createExtensionRegistry } from '../extensions/extension-registry.js';
export type {
  ExtensionPhase,
  ExtensionContext,
  ExtensionResult,
  ExtensionHandlerFn,
  ExtensionSpec
} from '../extensions/extension-registry.js';

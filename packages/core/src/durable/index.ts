/**
 * Core Durable Execution barrel.
 */

export {
  DURABLE_SETTINGS_KEY,
  defaultDurableSettings,
  normalizeDurableSettings,
  hasPersistedDurableSettings,
  readDurableSettings,
  writeDurableSettings,
  MemoryDurableJournal,
  deriveStepIdempotencyKey,
  resolveToolEffectClass,
  resolveToolReplayPolicy,
  canReplayUnknownStep,
  shouldTriggerWaveCompensation,
  partitionCallsByEffectStage,
  createInitialDurableKernelState,
  normalizeDurableKernelState,
  INTERRUPTED_UNSAFE_RESULT,
} from '@ppeng/agent-loop';

export type {
  DurableMode,
  DurableWorkspaceBackend,
  ChatRestartPolicy,
  WaveRollbackPolicy,
  EffectClass,
  ReplayPolicy,
  DurableRunStatus,
  DurableStepKind,
  DurableStepPhase,
  DurableSignalState,
  CompensationSpec,
  ToolParkDirective,
  ToolParkSignalRef,
  ToolReconcileOutcome,
  KernelCheckpointState,
  DurableRunRecord,
  DurableStepRecord,
  DurableSignalRecord,
  DurableJournalPort,
  DurableSettings,
  DurableSettingsPatch,
  DurableSettingsStore,
  DurableToolLoopContext,
  DurableKernelConfig,
  DurableRunSession,
} from '@ppeng/agent-loop';

export {
  DURABLE_SCHEMA_SQL,
  ensureDurableSchema,
  SqliteDurableJournal,
  openStandaloneSqliteDurableJournal,
} from '@ppeng/agent-loop/full';

export {
  recoverDurableRunsOnBoot,
  closeUnsafeOpenToolCallsOnBoot,
  cancelDurableRunsForSession,
  tickDurableRecovery,
  type DurableSchedulerHost,
} from './recovery.js';

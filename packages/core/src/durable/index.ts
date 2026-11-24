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

export {
  CasFileJournalTx,
  atomicWriteFile,
  collectWorkspaceFiles,
  pruneEmptyParentDirs,
  type CasFileEntry,
  type CasManifest,
} from './cas-file-tx.js';

export {
  GitShadowWorkspaceTx,
  isGitWorkspace,
  isGitDirty,
  parseRawDiffTreeZ,
} from './git-shadow-tx.js';

export {
  tryCreateApfsClone,
  tryCreateGitWorktree,
  removeIsolatedDir,
  commitIsolatedDelta,
  type IsolatedScopeState,
} from './isolated-tx.js';

export { CompositeWorkspaceTxManager } from './workspace-tx-manager.js';

export {
  rollbackSessionToStep,
  type SessionRollbackInput,
  type SessionRollbackOutcome,
} from './rollback-service.js';

/**
 * Durable Execution contracts & settings — zero Node I/O, safe for `mini`.
 *
 * Defines the portable control-plane primitives (run frames, single-tool
 * intent-first steps, replay policy, memos, signals, kernel checkpoint state,
 * and Lab-persisted DurableSettings) without coupling `mini` to sqlite or fs.
 */

import { nowIso } from '../helpers.js';

export const DURABLE_SETTINGS_KEY = 'durable_settings';

export type DurableMode = 'off' | 'journal_only' | 'atomic_workspace';
export type DurableWorkspaceBackend = 'auto' | 'git_shadow' | 'cow' | 'cas_file';
export type ChatRestartPolicy = 'auto_resume' | 'park_resumable' | 'legacy_fail';
export type WaveRollbackPolicy = 'on_tool_error' | 'abort_or_tx_only';

export type EffectClass =
  | 'read'
  | 'internal'
  | 'workspace_fs'
  | 'external_compensatable'
  | 'external_irreversible';

export type ReplayPolicy = 'safe' | 'unsafe';

export type DurableRunStatus =
  | 'running'
  | 'waiting_park'
  | 'completing'
  | 'rolling_back'
  | 'rolled_back'
  | 'needs_reconcile'
  | 'resumable'
  | 'suspended_interrupted'
  | 'completed'
  | 'failed'
  | 'aborted';

export type DurableStepKind =
  | 'llm_turn'
  | 'tool_call'
  | 'park'
  | 'tx_commit'
  | 'tx_rollback';

export type DurableStepPhase =
  | 'planned'
  | 'dispatched'
  | 'parked'
  | 'committed'
  | 'failed'
  | 'unknown'
  | 'compensating'
  | 'compensated'
  | 'compensation_failed';

export type DurableSignalState = 'pending' | 'consumed' | 'expired';

export interface CompensationSpec {
  readonly kind: string;
  readonly toolName: string;
  readonly payload: Record<string, unknown>;
}

export interface ToolParkSignalRef {
  readonly name: string;
  readonly key: string;
}

export interface ToolParkDirective {
  readonly kind: 'park';
  readonly signals?: readonly ToolParkSignalRef[];
  readonly untilMs?: number;
  readonly checkpoint?: Record<string, unknown>;
  readonly summary?: string;
}

export interface ToolReconcileOutcome {
  readonly status: 'committed' | 'not_applied' | 'unknown';
  readonly ok?: boolean;
  readonly content?: string;
  readonly receipt?: Record<string, unknown>;
}

export interface KernelCheckpointState {
  turn: number;
  stepCursor: number;
  advisoryGraceUsed: number;
  pendingAdvisories: string[];
  spinNoProgressStreak: number;
  cumulativeInputTokens: number;
  sameToolStreak: number;
  loopFailureCount: number;
  riskScore: number;
}

export interface DurableRunRecord {
  runId: string;
  sessionId: string;
  parentRunId?: string;
  fencingEpoch: number;
  status: DurableRunStatus;
  txScopeId?: string;
  passedPivot: boolean;
  restarts: number;
  kernelState: KernelCheckpointState;
  errorText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurableStepRecord {
  stepId: string;
  runId: string;
  sessionId: string;
  turn: number;
  waveIndex: number;
  fencingEpoch?: number;
  kind: DurableStepKind;
  toolCallId?: string;
  toolName?: string;
  idempotencyKey: string;
  effectClass: EffectClass;
  replayPolicy: ReplayPolicy;
  phase: DurableStepPhase;
  argsHash?: string;
  messageSeq?: number;
  snapshotRef?: string;
  receipt?: Record<string, unknown>;
  compensationSpec?: CompensationSpec;
  park?: ToolParkDirective;
  errorText?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export interface DurableSignalRecord {
  runId: string;
  stepId: string;
  signalName: string;
  signalKey: string;
  state: DurableSignalState;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDurableStepInput {
  stepId?: string;
  runId: string;
  sessionId: string;
  turn: number;
  waveIndex: number;
  fencingEpoch?: number;
  kind: DurableStepKind;
  toolCallId?: string;
  toolName?: string;
  idempotencyKey: string;
  effectClass: EffectClass;
  replayPolicy: ReplayPolicy;
  argsHash?: string;
  snapshotRef?: string;
}

export interface CommitDurableStepPatch {
  messageSeq?: number;
  snapshotRef?: string;
  receipt?: Record<string, unknown>;
  compensationSpec?: CompensationSpec;
  finishedAt?: string;
}

export interface UpdateDurableRunPatch {
  status?: DurableRunStatus;
  fencingEpoch?: number;
  txScopeId?: string;
  passedPivot?: boolean;
  restarts?: number;
  kernelState?: KernelCheckpointState;
  errorText?: string;
}

export interface DurableJournalPort {
  beginRun(input: {
    runId: string;
    sessionId: string;
    parentRunId?: string;
    txScopeId?: string;
    kernelState?: KernelCheckpointState;
  }): DurableRunRecord;
  getRun(runId: string): DurableRunRecord | undefined;
  getLatestRunForSession(sessionId: string): DurableRunRecord | undefined;
  listRunsForSession(sessionId: string, limit?: number): DurableRunRecord[];
  listRunsByStatus(statuses: readonly DurableRunStatus[]): DurableRunRecord[];
  listChildRuns(parentRunId: string): DurableRunRecord[];
  updateRun(runId: string, patch: UpdateDurableRunPatch): DurableRunRecord;

  planStep(input: PlanDurableStepInput): DurableStepRecord;
  getStep(stepId: string): DurableStepRecord | undefined;
  getStepByToolCall(runId: string, toolCallId: string, turn?: number): DurableStepRecord | undefined;
  listSteps(runId: string): DurableStepRecord[];
  markStepDispatched(stepId: string, opts?: { snapshotRef?: string; startedAt?: string }): DurableStepRecord;
  commitStep(stepId: string, patch?: CommitDurableStepPatch): DurableStepRecord;
  failStep(stepId: string, errorText: string, patch?: { messageSeq?: number }): DurableStepRecord;
  markStepUnknown(stepId: string, reason: string): DurableStepRecord;
  parkStep(stepId: string, park: ToolParkDirective): DurableStepRecord;
  updateStepPhase(
    stepId: string,
    phase: DurableStepPhase,
    patch?: { errorText?: string; receipt?: Record<string, unknown>; snapshotRef?: string }
  ): DurableStepRecord;

  /** First-writer-wins step-scoped memoization for external idempotency keys. */
  memo<T>(stepId: string, key: string, value: T): T;
  getMemo<T = unknown>(stepId: string, key: string): T | undefined;

  deliverSignal(input: {
    runId: string;
    stepId: string;
    signalName: string;
    signalKey: string;
    payload: unknown;
  }): { status: 'delivered' | 'duplicate' | 'closed' };
  readSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined;
  listSignals(runId: string): DurableSignalRecord[];
  consumeSignal(runId: string, stepId: string, signalName: string, signalKey: string): DurableSignalRecord | undefined;
  expireSignals(runId: string, stepId: string): number;

  /** Optional atomic transaction wrapper when sharing a backing DB. */
  withTransaction?<T>(fn: () => T): T;
}

export interface DurableSettings {
  mode: DurableMode;
  workspaceBackend: DurableWorkspaceBackend;
  chatRestartPolicy: ChatRestartPolicy;
  waveRollbackPolicy: WaveRollbackPolicy;
  isolateLongTasks: boolean;
  restartLimit: number;
  savepointTimeoutMs: number;
  updatedAt: string;
}

export type DurableSettingsPatch = Partial<Omit<DurableSettings, 'updatedAt'>>;

export interface DurableSettingsStore {
  getDaemonControl?<T = unknown>(key: string): T | undefined;
  setDaemonControl?(key: string, value: unknown): void;
}

export function defaultDurableSettings(): DurableSettings {
  return {
    mode: 'journal_only',
    workspaceBackend: 'auto',
    chatRestartPolicy: 'auto_resume',
    waveRollbackPolicy: 'abort_or_tx_only',
    isolateLongTasks: false,
    restartLimit: 5,
    savepointTimeoutMs: 300,
    updatedAt: nowIso(),
  };
}

function parseMode(raw: unknown): DurableMode | undefined {
  if (raw === 'off' || raw === 'journal_only' || raw === 'atomic_workspace') return raw;
  return undefined;
}

function parseBackend(raw: unknown): DurableWorkspaceBackend | undefined {
  if (raw === 'auto' || raw === 'git_shadow' || raw === 'cow' || raw === 'cas_file') return raw;
  return undefined;
}

function parseRestartPolicy(raw: unknown): ChatRestartPolicy | undefined {
  if (raw === 'auto_resume' || raw === 'park_resumable' || raw === 'legacy_fail') return raw;
  return undefined;
}

function parseWaveRollbackPolicy(raw: unknown): WaveRollbackPolicy | undefined {
  if (raw === 'abort_or_tx_only' || raw === 'on_tool_error') return raw;
  return undefined;
}

function parsePositiveInt(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  return n >= min && n <= max ? n : undefined;
}

export function normalizeDurableSettings(
  raw: Partial<DurableSettings> | null | undefined
): DurableSettings {
  const base = defaultDurableSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    mode: parseMode(raw.mode) ?? base.mode,
    workspaceBackend: parseBackend(raw.workspaceBackend) ?? base.workspaceBackend,
    chatRestartPolicy: parseRestartPolicy(raw.chatRestartPolicy) ?? base.chatRestartPolicy,
    waveRollbackPolicy: parseWaveRollbackPolicy(raw.waveRollbackPolicy) ?? base.waveRollbackPolicy,
    isolateLongTasks: typeof raw.isolateLongTasks === 'boolean' ? raw.isolateLongTasks : base.isolateLongTasks,
    restartLimit: parsePositiveInt(raw.restartLimit, 1, 100) ?? base.restartLimit,
    savepointTimeoutMs: parsePositiveInt(raw.savepointTimeoutMs, 50, 30_000) ?? base.savepointTimeoutMs,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
  };
}

export function hasPersistedDurableSettings(store?: DurableSettingsStore): boolean {
  return store?.getDaemonControl?.(DURABLE_SETTINGS_KEY) != null;
}

export function readDurableSettings(store?: DurableSettingsStore): DurableSettings {
  const saved = store?.getDaemonControl?.(DURABLE_SETTINGS_KEY);
  if (!saved) return defaultDurableSettings();
  return normalizeDurableSettings(saved as Partial<DurableSettings>);
}

export function writeDurableSettings(
  store: DurableSettingsStore,
  patch: DurableSettingsPatch
): DurableSettings {
  if (typeof store.setDaemonControl !== 'function') {
    throw new Error('durable settings store cannot persist');
  }
  const next = normalizeDurableSettings({
    ...readDurableSettings(store),
    ...patch,
    updatedAt: nowIso(),
  });
  store.setDaemonControl(DURABLE_SETTINGS_KEY, next);
  return next;
}

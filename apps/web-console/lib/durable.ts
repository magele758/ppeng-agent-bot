/**
 * Pure data types and helpers for Lab Durable Execution settings and timeline UI.
 * Every exported function is kept at cyclomatic complexity <= 4 for CRAP compliance.
 */

export type DurableMode = 'off' | 'journal_only' | 'atomic_workspace';
export type DurableWorkspaceBackend = 'auto' | 'git_shadow' | 'cow' | 'cas_file';
export type ChatRestartPolicy = 'auto_resume' | 'park_resumable' | 'legacy_fail';
export type WaveRollbackPolicy = 'on_tool_error' | 'abort_or_tx_only';

export interface DurableSettings {
  mode: DurableMode;
  workspaceBackend: DurableWorkspaceBackend;
  chatRestartPolicy: ChatRestartPolicy;
  waveRollbackPolicy: WaveRollbackPolicy;
  isolateLongTasks: boolean;
  restartLimit: number;
  savepointTimeoutMs: number;
  updatedAt?: string;
}

export type DurableEnumKey = 'mode' | 'workspaceBackend' | 'chatRestartPolicy' | 'waveRollbackPolicy';
export type DurableNumberKey = 'restartLimit' | 'savepointTimeoutMs';

export interface DurableRunView {
  runId: string;
  sessionId: string;
  parentRunId?: string;
  fencingEpoch: number;
  status: string;
  txScopeId?: string;
  passedPivot: boolean;
  restarts: number;
  errorText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurableStepView {
  stepId: string;
  runId: string;
  sessionId: string;
  turn: number;
  waveIndex: number;
  kind: string;
  toolCallId?: string;
  toolName?: string;
  effectClass: string;
  replayPolicy: string;
  phase: string;
  messageSeq?: number;
  snapshotRef?: string;
  errorText?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DurableSignalView {
  signalId: string;
  runId: string;
  stepId: string;
  signalName: string;
  signalKey: string;
  state: string;
  deliveredAt: string;
}

export interface DurableSessionPayload {
  sessionId: string;
  settings: DurableSettings;
  latestRun: DurableRunView | null;
  runs: DurableRunView[];
  steps: DurableStepView[];
  signals: DurableSignalView[];
  childRuns: DurableRunView[];
}

export const DURABLE_DEFAULTS: DurableSettings = {
  mode: 'atomic_workspace',
  workspaceBackend: 'auto',
  chatRestartPolicy: 'auto_resume',
  waveRollbackPolicy: 'abort_or_tx_only',
  isolateLongTasks: false,
  restartLimit: 5,
  savepointTimeoutMs: 300,
};

export const DURABLE_ENUM_VALUES: Record<DurableEnumKey, readonly string[]> = {
  mode: ['atomic_workspace', 'journal_only', 'off'],
  workspaceBackend: ['auto', 'git_shadow', 'cow', 'cas_file'],
  chatRestartPolicy: ['auto_resume', 'park_resumable', 'legacy_fail'],
  waveRollbackPolicy: ['abort_or_tx_only', 'on_tool_error'],
};

export const DURABLE_NUMBER_CHOICES: Record<DurableNumberKey, readonly number[]> = {
  restartLimit: [1, 3, 5, 10, 20],
  savepointTimeoutMs: [100, 300, 500, 1000, 3000],
};

export function durableNumberOptions(
  key: DurableNumberKey,
  current: number
): Array<{ value: string; label: string }> {
  const values = new Set([...DURABLE_NUMBER_CHOICES[key], current]);
  return [...values].sort((a, b) => a - b).map((v) => ({ value: String(v), label: String(v) }));
}

export function isStepNeedsOperatorResolve(step: Pick<DurableStepView, 'phase'>): boolean {
  return step.phase === 'unknown' || step.phase === 'compensation_failed';
}

export function canRollbackToStep(step: Pick<DurableStepView, 'kind' | 'phase'>): boolean {
  if (step.kind !== 'tool_call') return false;
  return step.phase === 'committed' || step.phase === 'failed';
}

export function durableSessionEndpoint(sessionId: string, suffix = ''): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/durable${suffix}`;
}

export function durableStepResolveEndpoint(sessionId: string, stepId: string): string {
  return `${durableSessionEndpoint(sessionId)}/steps/${encodeURIComponent(stepId)}/resolve`;
}

export function durableErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

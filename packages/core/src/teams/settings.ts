import { nowIso } from '../id.js';
import type { TeamGateChecker, TeamWorkspaceSyncMode } from './types.js';

export const TEAMS_DAG_SETTINGS_KEY = 'teams_dag_settings';
export const DEFAULT_TEAM_CONCURRENCY = 16;
export const TEAM_CONCURRENCY_LIMIT = 256;

export interface TeamGateSettings {
  enabled: boolean;
  checker: TeamGateChecker;
  /** Command-existence check only; never executed as a shell script. */
  command?: string;
}

export interface TeamsDagSettings {
  enabled: boolean;
  maxConcurrent: number;
  workspaceSyncMode: TeamWorkspaceSyncMode;
  usePlannerLlm: boolean;
  gates: {
    review: TeamGateSettings;
    regression: TeamGateSettings;
    release: TeamGateSettings;
  };
  updatedAt: string;
}

export interface TeamsDagSettingsPatch {
  enabled?: boolean;
  maxConcurrent?: number;
  workspaceSyncMode?: TeamWorkspaceSyncMode;
  usePlannerLlm?: boolean;
  gates?: {
    review?: Partial<TeamGateSettings>;
    regression?: Partial<TeamGateSettings>;
    release?: Partial<TeamGateSettings>;
  };
  /** @deprecated mapped to gates.review.enabled */
  requireReview?: boolean;
}

export interface TeamsDagSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl?(key: string, value: unknown): void;
}

const CHECKERS: readonly TeamGateChecker[] = ['human', 'llm', 'command'];

function normalizeChecker(raw: unknown, fallback: TeamGateChecker): TeamGateChecker {
  return typeof raw === 'string' && (CHECKERS as readonly string[]).includes(raw)
    ? (raw as TeamGateChecker)
    : fallback;
}

function normalizeCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cmd = raw.trim();
  if (!cmd || !/^[A-Za-z0-9._+-]+$/.test(cmd)) return undefined;
  return cmd;
}

function normalizeGate(
  raw: Partial<TeamGateSettings> | null | undefined,
  fallback: TeamGateSettings
): TeamGateSettings {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const command = normalizeCommand(raw.command) ?? fallback.command;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    checker: normalizeChecker(raw.checker, fallback.checker),
    ...(command ? { command } : {})
  };
}

export function defaultTeamsDagSettings(): TeamsDagSettings {
  return {
    enabled: true,
    maxConcurrent: DEFAULT_TEAM_CONCURRENCY,
    workspaceSyncMode: 'directory-copy',
    usePlannerLlm: true,
    gates: {
      review: { enabled: true, checker: 'llm' },
      regression: { enabled: false, checker: 'command' },
      release: { enabled: true, checker: 'llm' }
    },
    updatedAt: nowIso()
  };
}

export function normalizeTeamsDagSettings(raw: Partial<TeamsDagSettings & { requireReview?: boolean }> | null | undefined): TeamsDagSettings {
  const base = defaultTeamsDagSettings();
  if (!raw || typeof raw !== 'object') return base;
  const max =
    typeof raw.maxConcurrent === 'number' && Number.isFinite(raw.maxConcurrent)
      ? Math.max(1, Math.min(TEAM_CONCURRENCY_LIMIT, Math.floor(raw.maxConcurrent)))
      : base.maxConcurrent;
  const sync =
    raw.workspaceSyncMode === 'git-worktree' ? 'git-worktree' : base.workspaceSyncMode;
  const reviewFallback = {
    ...base.gates.review,
    enabled: raw.requireReview === false ? false : base.gates.review.enabled
  };
  return {
    enabled: raw.enabled !== false,
    maxConcurrent: max,
    workspaceSyncMode: sync,
    usePlannerLlm: raw.usePlannerLlm !== false,
    gates: {
      review: normalizeGate(raw.gates?.review, reviewFallback),
      regression: normalizeGate(raw.gates?.regression, base.gates.regression),
      release: normalizeGate(raw.gates?.release, base.gates.release)
    },
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

export function readTeamsDagSettings(store: TeamsDagSettingsStore): TeamsDagSettings {
  const saved = store.getDaemonControl<Partial<TeamsDagSettings>>(TEAMS_DAG_SETTINGS_KEY);
  if (!saved) return defaultTeamsDagSettings();
  return normalizeTeamsDagSettings(saved);
}

export function writeTeamsDagSettings(
  store: TeamsDagSettingsStore,
  patch: TeamsDagSettingsPatch
): TeamsDagSettings {
  const current = readTeamsDagSettings(store);
  const next = normalizeTeamsDagSettings({
    ...current,
    ...patch,
    gates: {
      review: { ...current.gates.review, ...patch.gates?.review },
      regression: { ...current.gates.regression, ...patch.gates?.regression },
      release: { ...current.gates.release, ...patch.gates?.release }
    },
    updatedAt: nowIso()
  });
  if (!store.setDaemonControl) {
    throw new Error('Teams DAG settings store is read-only');
  }
  store.setDaemonControl(TEAMS_DAG_SETTINGS_KEY, next);
  return next;
}

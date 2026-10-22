/**
 * Agent-loop Lab settings (steer drain + inbox overflow cap).
 * Persisted in daemon_control KV. Same key/shape core resolvers read
 * (`loop_settings.steerDrainPolicy`, `loop_settings.inboxOverflowCap`).
 * No RAW_AGENT_* switches — UI / PATCH /api/loop/settings is the control plane.
 */

import {
  AGENT_LOOP_SETTINGS_KEY,
  DEFAULT_STEER_DRAIN_POLICY,
  DEFAULT_STEER_INTERRUPT_POLICY,
  parseInboxOverflowCap,
  parseSkillScope,
  parseSteerDrainPolicy,
  parseSteerInterruptPolicy,
  parseTaskMode,
  type SkillScope,
  type SteerDrainPolicy,
  type SteerInterruptPolicy,
  type TaskMode
} from '@ppeng/agent-core';

export type { SkillScope, SteerInterruptPolicy, TaskMode };

export const LOOP_SETTINGS_KEY = AGENT_LOOP_SETTINGS_KEY;
export { parseInboxOverflowCap, parseSteerDrainPolicy, parseSteerInterruptPolicy };
export type { SteerDrainPolicy };

/** Default: steer lands on the next model shot only (kernel lock); inbox never drops. */
export type KernelVariant = 'ppeng' | 'agent-loop';
export type AssemblyPreset = 'mini' | 'normal' | 'full' | 'max';
/**
 * Same three values as `parseRepeatGuardMode` in
 * packages/agent-loop/src/recovery/repeat-guard.ts.
 * Missing or unknown stays `weak` (strong models are not cut off).
 */
export type RepeatGuardMode = 'weak' | 'all' | 'off';

export interface LoopSettings {
  steerDrainPolicy: SteerDrainPolicy;
  /** null = unlimited (default). Positive integer = max unclaimed inbox items. */
  inboxOverflowCap: number | null;
  /** Lab default HOW for new / unbound sessions. */
  defaultTaskMode: TaskMode;
  /** Lab default WHAT. Only full | requested. */
  defaultSkillScope: SkillScope;
  /** Running-turn interrupt: queue | steer | disabled. */
  steerInterruptPolicy: SteerInterruptPolicy;
  /**
   * Which turn kernel drives `runSession`.
   * - `agent-loop` (default): @ppeng/agent-loop runSessionKernel.
   * - `ppeng`: local packages/core/src/turn/kernel.ts (reference / A/B).
   */
  kernelVariant: KernelVariant;
  /** A assembly tier when kernelVariant is agent-loop. Product default is max. */
  assemblyPreset: AssemblyPreset;
  /**
   * Identical tool-content aborts and file-view count caps.
   * `weak` (default) constrains weak models only; `all` constrains every model; `off` constrains none.
   */
  repeatGuard: RepeatGuardMode;
  updatedAt: string;
}

export interface LoopSettingsPatch {
  steerDrainPolicy?: SteerDrainPolicy;
  inboxOverflowCap?: number | null;
  defaultTaskMode?: TaskMode;
  defaultSkillScope?: SkillScope;
  steerInterruptPolicy?: SteerInterruptPolicy;
  kernelVariant?: KernelVariant;
  assemblyPreset?: AssemblyPreset;
  repeatGuard?: RepeatGuardMode;
}

export interface LoopSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export function defaultLoopSettings(): LoopSettings {
  return {
    steerDrainPolicy: DEFAULT_STEER_DRAIN_POLICY,
    inboxOverflowCap: null,
    defaultTaskMode: 'auto',
    defaultSkillScope: 'full',
    steerInterruptPolicy: DEFAULT_STEER_INTERRUPT_POLICY,
    kernelVariant: 'agent-loop',
    assemblyPreset: 'max',
    repeatGuard: 'weak',
    updatedAt: new Date().toISOString()
  };
}

export function normalizeLoopSettings(raw: Partial<LoopSettings> | null | undefined): LoopSettings {
  const base = defaultLoopSettings();
  if (!raw || typeof raw !== 'object') return base;
  const policy = parseSteerDrainPolicy(raw.steerDrainPolicy);
  const cap =
    'inboxOverflowCap' in raw ? parseInboxOverflowCap(raw.inboxOverflowCap) : undefined;
  const mode = parseTaskMode(raw.defaultTaskMode);
  const scope = parseSkillScope(raw.defaultSkillScope);
  const interrupt = parseSteerInterruptPolicy(raw.steerInterruptPolicy);
  return {
    steerDrainPolicy: policy ?? base.steerDrainPolicy,
    inboxOverflowCap: cap === undefined ? base.inboxOverflowCap : cap,
    defaultTaskMode: mode ?? base.defaultTaskMode,
    defaultSkillScope: scope ?? base.defaultSkillScope,
    steerInterruptPolicy: interrupt ?? base.steerInterruptPolicy,
    kernelVariant: parseKernelVariant(raw.kernelVariant) ?? base.kernelVariant,
    assemblyPreset: parseAssemblyPreset(raw.assemblyPreset) ?? base.assemblyPreset,
    repeatGuard: parseRepeatGuardMode(raw.repeatGuard) ?? base.repeatGuard,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}
export function parseKernelVariant(raw: unknown): KernelVariant | undefined {
  return raw === 'ppeng' || raw === 'agent-loop' ? raw : undefined;
}

export function parseAssemblyPreset(raw: unknown): AssemblyPreset | undefined {
  return raw === 'mini' || raw === 'normal' || raw === 'full' || raw === 'max' ? raw : undefined;
}

export function parseRepeatGuardMode(raw: unknown): RepeatGuardMode | undefined {
  switch (raw) {
    case 'weak':
    case 'all':
    case 'off':
      return raw;
    default:
      return undefined;
  }
}

export function readLoopSettings(store: LoopSettingsStore): LoopSettings {
  const saved = store.getDaemonControl<Partial<LoopSettings>>(LOOP_SETTINGS_KEY);
  if (!saved) return defaultLoopSettings();
  return normalizeLoopSettings(saved);
}

export function writeLoopSettings(store: LoopSettingsStore, patch: LoopSettingsPatch): LoopSettings {
  const current = readLoopSettings(store);
  const next = normalizeLoopSettings({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  store.setDaemonControl(LOOP_SETTINGS_KEY, next);
  return next;
}

export function hasPersistedLoopSettings(store: LoopSettingsStore): boolean {
  return store.getDaemonControl(LOOP_SETTINGS_KEY) != null;
}

/** Explicit runSession option; kernel also reads the same KV as fallback. */
export function loopSettingsAsRuntimeHint(settings: LoopSettings): {
  steerDrainPolicy: SteerDrainPolicy;
  inboxOverflowCap: number | null;
  defaultTaskMode: TaskMode;
  defaultSkillScope: SkillScope;
  steerInterruptPolicy: SteerInterruptPolicy;
} {
  return {
    steerDrainPolicy: settings.steerDrainPolicy,
    inboxOverflowCap: settings.inboxOverflowCap,
    defaultTaskMode: settings.defaultTaskMode,
    defaultSkillScope: settings.defaultSkillScope,
    steerInterruptPolicy: settings.steerInterruptPolicy
  };
}

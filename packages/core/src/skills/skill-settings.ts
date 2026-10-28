/**
 * Persisted Lab disclosure and routing settings. Each unsaved routing field
 * falls back to its existing environment/default value; no new env switches.
 */

import { nowIso } from '../id.js';
import { skillRoutingModeFromEnv, skillRoutingTopKFromEnv, skillLoadStrictFromEnv, skillRoutingFusionFromEnv, type SkillRoutingMode } from './skill-router.js';
import { ValidationError } from '../errors.js';

export const SKILL_SETTINGS_KEY = 'skill_settings';

export const SKILL_DISCLOSURE_MODES = ['shortlist', 'lazy', 'full'] as const;

export type SkillDisclosureMode = (typeof SKILL_DISCLOSURE_MODES)[number];

export interface SkillRoutingSettings {
  routingMode: SkillRoutingMode;
  topK: number;
  strictLoad: boolean;
  fusion: boolean;
}

export interface SkillSettings extends Partial<SkillRoutingSettings> {
  disclosureMode: SkillDisclosureMode;
  updatedAt: string;
}

export interface SkillSettingsPatch extends Partial<SkillRoutingSettings> {
  disclosureMode?: SkillDisclosureMode;
}

export interface SkillSettingsStore {
  getDaemonControl(key: string): unknown;
  setDaemonControl?(key: string, value: unknown): void;
}

export function parseSkillDisclosureMode(raw: unknown): SkillDisclosureMode | undefined {
  if (typeof raw !== 'string') return undefined;
  return (SKILL_DISCLOSURE_MODES as readonly string[]).includes(raw)
    ? (raw as SkillDisclosureMode)
    : undefined;
}

export function defaultSkillSettings(): SkillSettings {
  return {
    disclosureMode: 'shortlist',
    updatedAt: nowIso()
  };
}

export function normalizeSkillSettings(
  raw: Partial<SkillSettings> | null | undefined
): SkillSettings {
  const base = defaultSkillSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    disclosureMode: parseSkillDisclosureMode(raw.disclosureMode) ?? base.disclosureMode,
    ...routingPatch(raw),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

function isReadStore(store: unknown): store is SkillSettingsStore {
  return !!store && typeof (store as SkillSettingsStore).getDaemonControl === 'function';
}

export function hasPersistedSkillSettings(
  store: { getDaemonControl?(key: string): unknown } | undefined
): boolean {
  if (!isReadStore(store)) return false;
  return store.getDaemonControl(SKILL_SETTINGS_KEY) != null;
}

export function readSkillSettings(store: SkillSettingsStore): SkillSettings {
  const saved = store.getDaemonControl(SKILL_SETTINGS_KEY);
  if (!saved) return defaultSkillSettings();
  return normalizeSkillSettings(saved as Partial<SkillSettings>);
}

export function writeSkillSettings(
  store: SkillSettingsStore,
  patch: SkillSettingsPatch
): SkillSettings {
  if (typeof store.setDaemonControl !== 'function') {
    throw new Error('skill settings store cannot persist');
  }
  routingPatch(patch);
  if (patch.disclosureMode !== undefined && !parseSkillDisclosureMode(patch.disclosureMode)) throw new ValidationError("Invalid disclosureMode");
  const current = store.getDaemonControl(SKILL_SETTINGS_KEY) as Partial<SkillSettings> | undefined;
  const next = {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
  store.setDaemonControl(SKILL_SETTINGS_KEY, next);
  return normalizeSkillSettings(next);
}

function disclosureFromEnv(env: NodeJS.ProcessEnv | undefined): SkillDisclosureMode {
  return skillRoutingModeFromEnv(env) === 'legacy' ? 'full' : 'shortlist';
}

/** Effective disclosure: persisted Lab value wins after the first save. */
export function resolveSkillDisclosureMode(input: {
  store?: { getDaemonControl?(key: string): unknown };
  env?: NodeJS.ProcessEnv;
}): SkillDisclosureMode {
  if (!hasPersistedSkillSettings(input.store) || !input.store?.getDaemonControl) {
    return disclosureFromEnv(input.env);
  }
  const saved = input.store.getDaemonControl(SKILL_SETTINGS_KEY) as Partial<SkillSettings>;
  return parseSkillDisclosureMode(saved.disclosureMode) ?? disclosureFromEnv(input.env);
}

function routingPatch(raw: Partial<SkillRoutingSettings>): Partial<SkillRoutingSettings> {
  const out: Partial<SkillRoutingSettings> = {};
  if (raw.routingMode !== undefined) {
    if (!['legacy','lexical','hybrid'].includes(raw.routingMode)) throw new ValidationError('Invalid routingMode');
    out.routingMode = raw.routingMode;
  }
  if (raw.topK !== undefined) {
    if (!Number.isInteger(raw.topK) || raw.topK < 1 || raw.topK > 50) throw new ValidationError('topK must be an integer from 1 to 50');
    out.topK = raw.topK;
  }
  for (const key of ['strictLoad','fusion'] as const) if (raw[key] !== undefined) {
    if (typeof raw[key] !== 'boolean') throw new ValidationError(key + ' must be boolean');
    out[key] = raw[key];
  }
  return out;
}

export function resolveSkillRoutingSettings(input: {store?: {getDaemonControl?(key:string):unknown}; env?: NodeJS.ProcessEnv}): SkillRoutingSettings {
  const env = input.env ?? process.env;
  const saved = input.store?.getDaemonControl?.(SKILL_SETTINGS_KEY) as Partial<SkillSettings> | undefined;
  return {routingMode: skillRoutingModeFromEnv(env), topK: skillRoutingTopKFromEnv(env), strictLoad: skillLoadStrictFromEnv(env), fusion: skillRoutingFusionFromEnv(env), ...routingPatch(saved ?? {})};
}

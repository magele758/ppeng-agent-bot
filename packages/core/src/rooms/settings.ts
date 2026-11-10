import { ValidationError } from '../errors.js';

export interface RoomSettings {
  rosterCap: number;
  maxRoomMembers: number;
  maxWaveSpeakers: number;
  /** Visible member replies allowed in a room during one minute. Further speakers wait. */
  maxRepliesPerMinute: number;
  /** Tool-call limit a new room starts with. 0 means the new room has none. */
  defaultMaxToolCalls: number;
  /** Cost budget in USD a new room starts with. 0 means the new room has none. */
  defaultMaxCostUsd: number;
}

export interface RoomSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl(key: string, value: unknown): void;
}

export const ROOM_SETTINGS_KEY = 'bot.roomSettings';

/** Defaults match the previous fixed caps so existing installs do not jump in size until Lab saves a higher value. */
export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  rosterCap: 50,
  maxRoomMembers: 50,
  maxWaveSpeakers: 4,
  maxRepliesPerMinute: 30,
  defaultMaxToolCalls: 0,
  defaultMaxCostUsd: 0
};

const LIMITS: Record<keyof RoomSettings, { min: number; max: number; fractional?: boolean }> = {
  rosterCap: { min: 1, max: 500 },
  maxRoomMembers: { min: 2, max: 200 },
  maxWaveSpeakers: { min: 1, max: 10 },
  maxRepliesPerMinute: { min: 1, max: 120 },
  defaultMaxToolCalls: { min: 0, max: 10000 },
  defaultMaxCostUsd: { min: 0, max: 1000, fractional: true }
};

function inRange(key: keyof RoomSettings, value: unknown): value is number {
  const limit = LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limit.min || value > limit.max) return false;
  return limit.fractional === true || Number.isInteger(value);
}

function stored(raw: Partial<RoomSettings>, key: keyof RoomSettings): number {
  return inRange(key, raw[key]) ? raw[key] : DEFAULT_ROOM_SETTINGS[key];
}

export function readRoomSettings(store: RoomSettingsStore): RoomSettings {
  const raw = store.getDaemonControl<Partial<RoomSettings>>(ROOM_SETTINGS_KEY) ?? {};
  return {
    rosterCap: stored(raw, 'rosterCap'),
    maxRoomMembers: stored(raw, 'maxRoomMembers'),
    maxWaveSpeakers: stored(raw, 'maxWaveSpeakers'),
    maxRepliesPerMinute: stored(raw, 'maxRepliesPerMinute'),
    defaultMaxToolCalls: stored(raw, 'defaultMaxToolCalls'),
    defaultMaxCostUsd: stored(raw, 'defaultMaxCostUsd')
  };
}

export function writeRoomSettings(store: RoomSettingsStore, patch: unknown): RoomSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('Room settings must be an object');
  const input = patch as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_ROOM_SETTINGS)) throw new ValidationError(`Unknown room setting ${key}`);
  }
  const next = { ...readRoomSettings(store) };
  for (const key of Object.keys(DEFAULT_ROOM_SETTINGS) as (keyof RoomSettings)[]) {
    if (input[key] === undefined) continue;
    const limit = LIMITS[key];
    const value = input[key];
    if (!inRange(key, value)) {
      throw new ValidationError(`${key} must be ${limit.fractional ? 'a number' : 'an integer'} from ${limit.min} to ${limit.max}`);
    }
    next[key] = value;
  }
  store.setDaemonControl(ROOM_SETTINGS_KEY, next);
  return next;
}

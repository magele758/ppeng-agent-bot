import { ValidationError } from '../errors.js';

export interface RoomSettings {
  rosterCap: number;
  maxRoomMembers: number;
  maxWaveSpeakers: number;
  /** Visible member replies allowed in a room during one minute. Further speakers wait. */
  maxRepliesPerMinute: number;
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
  maxRepliesPerMinute: 30
};

const LIMITS: Record<keyof RoomSettings, { min: number; max: number }> = {
  rosterCap: { min: 1, max: 500 },
  maxRoomMembers: { min: 2, max: 200 },
  maxWaveSpeakers: { min: 1, max: 10 },
  maxRepliesPerMinute: { min: 1, max: 120 }
};

function storedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function readRoomSettings(store: RoomSettingsStore): RoomSettings {
  const raw = store.getDaemonControl<Partial<RoomSettings>>(ROOM_SETTINGS_KEY) ?? {};
  return {
    rosterCap: storedInt(raw.rosterCap, DEFAULT_ROOM_SETTINGS.rosterCap, LIMITS.rosterCap.min, LIMITS.rosterCap.max),
    maxRoomMembers: storedInt(raw.maxRoomMembers, DEFAULT_ROOM_SETTINGS.maxRoomMembers, LIMITS.maxRoomMembers.min, LIMITS.maxRoomMembers.max),
    maxWaveSpeakers: storedInt(raw.maxWaveSpeakers, DEFAULT_ROOM_SETTINGS.maxWaveSpeakers, LIMITS.maxWaveSpeakers.min, LIMITS.maxWaveSpeakers.max),
    maxRepliesPerMinute: storedInt(raw.maxRepliesPerMinute, DEFAULT_ROOM_SETTINGS.maxRepliesPerMinute, LIMITS.maxRepliesPerMinute.min, LIMITS.maxRepliesPerMinute.max)
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
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limit.min || value > limit.max) {
      throw new ValidationError(`${key} must be an integer from ${limit.min} to ${limit.max}`);
    }
    next[key] = value;
  }
  store.setDaemonControl(ROOM_SETTINGS_KEY, next);
  return next;
}

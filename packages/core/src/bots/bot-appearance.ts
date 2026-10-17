import { ValidationError } from '../errors.js';

/** Stored face choices. Blank means the client keeps the name-based look. */
export const BOT_FACE_SHAPES = [
  'circle',
  'cloud',
  'squircle',
  'star',
  'clover',
  'heart',
  'flower',
  'teardrop',
  'bean',
  'triangle',
  'house',
  'splat',
  'hexagon',
  'tall'
] as const;

export type BotFaceShape = (typeof BOT_FACE_SHAPES)[number];

export const BOT_FACE_COLORS = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
  'white',
  'mint'
] as const;

export type BotFaceColor = (typeof BOT_FACE_COLORS)[number];

function readChoice<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  if (typeof raw !== 'string') return null;
  return allowed.includes(raw as T) ? (raw as T) : null;
}

export function readBotFaceShape(raw: unknown): BotFaceShape | null {
  return readChoice(raw, BOT_FACE_SHAPES);
}

export function readBotFaceColor(raw: unknown): BotFaceColor | null {
  return readChoice(raw, BOT_FACE_COLORS);
}

function requireChoice<T extends string>(field: string, raw: unknown, allowed: readonly T[]): T | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const choice = readChoice(raw, allowed);
  if (!choice) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return choice;
}

export function normalizeBotFaceShape(raw: unknown): BotFaceShape | null {
  return requireChoice('faceShape', raw, BOT_FACE_SHAPES);
}

export function normalizeBotFaceColor(raw: unknown): BotFaceColor | null {
  return requireChoice('faceColor', raw, BOT_FACE_COLORS);
}

/** Preset emoji offered when creating or editing a Bot. */
export const BOT_AVATAR_EMOJIS = [
  '🤖',
  '✨',
  '🦊',
  '🐱',
  '🦉',
  '🌸',
  '🌟',
  '📚',
  '🧭',
  '🧪',
  '🎨',
  '⚡️'
] as const;

export type BotAvatarEmoji = (typeof BOT_AVATAR_EMOJIS)[number];

const AVATAR_EMOJI_MAX = 16;
const AVATAR_URL_MAX = 500;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A saved avatar is one emoji (or a short emoji sequence) or an http(s) image URL.
 * Blank and invalid values clear it so the geometric face stays in charge.
 */
export function normalizeBotAvatar(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ValidationError('avatar must be an emoji or an image URL');
  }
  const value = raw.trim();
  if (!value) return null;
  if (isHttpUrl(value)) {
    if (value.length > AVATAR_URL_MAX) {
      throw new ValidationError(`avatar URL must be ≤ ${AVATAR_URL_MAX} characters`);
    }
    return value;
  }
  if (value.length > AVATAR_EMOJI_MAX || /\s/.test(value)) {
    throw new ValidationError('avatar must be an emoji or an http(s) image URL');
  }
  return value;
}

/** Fields present on a create/patch body. Absent keys are left unset. */
export function readFaceInput(body: Record<string, unknown>): {
  faceShape?: unknown;
  faceColor?: unknown;
  avatar?: unknown;
} {
  return {
    ...('faceShape' in body ? { faceShape: body.faceShape } : {}),
    ...('faceColor' in body ? { faceColor: body.faceColor } : {}),
    ...('avatar' in body ? { avatar: body.avatar } : {})
  };
}

/** Normalized face columns for an update. Omitted keys stay unchanged. */
export function faceUpdatePatch(patch: { faceShape?: unknown; faceColor?: unknown; avatar?: unknown }): {
  faceShape?: BotFaceShape | null;
  faceColor?: BotFaceColor | null;
  avatar?: string | null;
} {
  return {
    ...(patch.faceShape !== undefined ? { faceShape: normalizeBotFaceShape(patch.faceShape) } : {}),
    ...(patch.faceColor !== undefined ? { faceColor: normalizeBotFaceColor(patch.faceColor) } : {}),
    ...(patch.avatar !== undefined ? { avatar: normalizeBotAvatar(patch.avatar) } : {})
  };
}

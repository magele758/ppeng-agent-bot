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

/** Which icon set a bot draws. Absent, blank, or unknown stays on the classic face. */
export const BOT_FACE_STYLES = ['classic', 'soft'] as const;

export type BotFaceStyle = (typeof BOT_FACE_STYLES)[number];

/** Soft silhouettes stored in face_shape only while face_style is soft. */
export const SOFT_BOT_SILHOUETTES = [
  'pebble',
  'squish',
  'capsule',
  'cloud',
  'drop',
  'bean',
  'nub',
  'pillow'
] as const;

export type SoftBotSilhouette = (typeof SOFT_BOT_SILHOUETTES)[number];

/** Soft pastels stored in face_color only while face_style is soft. */
export const SOFT_BOT_COLORS = [
  'butter',
  'peach',
  'coral',
  'blush',
  'lilac',
  'sky',
  'mint',
  'sage',
  'sand',
  'ink'
] as const;

export type SoftBotColor = (typeof SOFT_BOT_COLORS)[number];

/** Soft resting looks. Stored only while face_style is soft. */
export const SOFT_BOT_EXPRESSIONS = [
  'neutral',
  'happy',
  'curious',
  'sleepy',
  'wink',
  'content',
  'wide',
  'shy'
] as const;

export type SoftBotExpression = (typeof SOFT_BOT_EXPRESSIONS)[number];

export type StoredFaceShape = BotFaceShape | SoftBotSilhouette;
export type StoredFaceColor = BotFaceColor | SoftBotColor;

function readChoice<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  if (typeof raw !== 'string') return null;
  return allowed.includes(raw as T) ? (raw as T) : null;
}

export function readBotFaceShape(raw: unknown): StoredFaceShape | null {
  return readChoice(raw, BOT_FACE_SHAPES) ?? readChoice(raw, SOFT_BOT_SILHOUETTES);
}

export function readBotFaceColor(raw: unknown): StoredFaceColor | null {
  return readChoice(raw, BOT_FACE_COLORS) ?? readChoice(raw, SOFT_BOT_COLORS);
}

function requireChoice<T extends string>(field: string, raw: unknown, allowed: readonly T[]): T | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
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

export function readBotFaceStyle(raw: unknown): BotFaceStyle | null {
  return readChoice(raw, BOT_FACE_STYLES);
}

/** Blank clears the column (classic). Anything else must be classic or soft. */
export function normalizeBotFaceStyle(raw: unknown): BotFaceStyle | null {
  return requireChoice('faceStyle', raw, BOT_FACE_STYLES);
}

/** Classic rows keep the geometric ids. A soft row may only store a soft id. */
export function normalizeFaceShapeForStyle(raw: unknown, style: BotFaceStyle | null): StoredFaceShape | null {
  if (style === 'soft') return requireChoice('faceShape', raw, SOFT_BOT_SILHOUETTES);
  return normalizeBotFaceShape(raw);
}

export function normalizeFaceColorForStyle(raw: unknown, style: BotFaceStyle | null): StoredFaceColor | null {
  if (style === 'soft') return requireChoice('faceColor', raw, SOFT_BOT_COLORS);
  return normalizeBotFaceColor(raw);
}

export function readBotFaceExpression(raw: unknown): SoftBotExpression | null {
  return readChoice(raw, SOFT_BOT_EXPRESSIONS);
}

/** Blank clears it. A classic row never stores one. Anything else must be a soft look. */
export function normalizeFaceExpressionForStyle(raw: unknown, style: BotFaceStyle | null): SoftBotExpression | null {
  if (style !== 'soft') {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'string' && raw.trim() === '') return null;
    throw new ValidationError('faceExpression is only saved for a soft face');
  }
  return requireChoice('faceExpression', raw, SOFT_BOT_EXPRESSIONS);
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
  faceStyle?: unknown;
  faceExpression?: unknown;
  avatar?: unknown;
} {
  return {
    ...('faceShape' in body ? { faceShape: body.faceShape } : {}),
    ...('faceColor' in body ? { faceColor: body.faceColor } : {}),
    ...('faceStyle' in body ? { faceStyle: body.faceStyle } : {}),
    ...('faceExpression' in body ? { faceExpression: body.faceExpression } : {}),
    ...('avatar' in body ? { avatar: body.avatar } : {})
  };
}

/** Normalized face columns for an update. Omitted keys stay unchanged. */
export function faceUpdatePatch(
  patch: {
    faceShape?: unknown;
    faceColor?: unknown;
    faceStyle?: unknown;
    faceExpression?: unknown;
    avatar?: unknown;
  },
  current?: { faceShape?: unknown; faceColor?: unknown; faceStyle?: BotFaceStyle | null }
): {
  faceShape?: StoredFaceShape | null;
  faceColor?: StoredFaceColor | null;
  faceStyle?: BotFaceStyle | null;
  faceExpression?: SoftBotExpression | null;
  avatar?: string | null;
} {
  const faceStyle = patch.faceStyle !== undefined ? normalizeBotFaceStyle(patch.faceStyle) : current?.faceStyle ?? null;
  // Null and classic are the same geometric face. Only a real soft/classic change drops the other set.
  const styleChanged = current !== undefined && patch.faceStyle !== undefined && (faceStyle === 'soft') !== (current.faceStyle === 'soft');
  return {
    ...(patch.faceShape !== undefined || styleChanged
      ? { faceShape: normalizeFaceShapeForStyle(styleChanged && patch.faceShape === undefined ? null : patch.faceShape, faceStyle) }
      : {}),
    ...(patch.faceColor !== undefined || styleChanged
      ? { faceColor: normalizeFaceColorForStyle(styleChanged && patch.faceColor === undefined ? null : patch.faceColor, faceStyle) }
      : {}),
    ...(patch.faceStyle !== undefined ? { faceStyle } : {}),
    ...(patch.faceExpression !== undefined || (styleChanged && faceStyle !== 'soft')
      ? {
          faceExpression: normalizeFaceExpressionForStyle(
            styleChanged && faceStyle !== 'soft' ? null : patch.faceExpression,
            faceStyle
          )
        }
      : {}),
    ...(patch.avatar !== undefined ? { avatar: normalizeBotAvatar(patch.avatar) } : {})
  };
}

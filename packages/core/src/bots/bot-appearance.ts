import { ValidationError } from '../errors.js';

/** Stored face choices. Blank means the client keeps the name-based look. */
export const BOT_FACE_SHAPES = ['squircle', 'circle', 'tall', 'bean'] as const;

export type BotFaceShape = (typeof BOT_FACE_SHAPES)[number];

export const BOT_FACE_COLORS = ['blue', 'white', 'orange', 'red', 'purple', 'mint', 'pink', 'yellow'] as const;

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

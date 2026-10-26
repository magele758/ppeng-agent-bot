/**
 * Optional Bot avatar: a preset emoji, or an http(s) image URL.
 * Blank means "keep the geometric face". The daemon repeats this check.
 */

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

const EMOJI_MAX = 16;
const URL_MAX = 500;

export type BotAvatarIssue = 'invalid';

export function isBotAvatarEmoji(value: string): value is BotAvatarEmoji {
  return (BOT_AVATAR_EMOJIS as readonly string[]).includes(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && value.length <= URL_MAX;
  } catch {
    return false;
  }
}

/** What to send. Null keeps the geometric face. */
export function botAvatarValue(emoji: string, imageUrl: string): string | null {
  const picture = imageUrl.trim();
  if (picture) return picture;
  const mark = emoji.trim();
  return mark || null;
}

function emojiIssue(emoji: string): BotAvatarIssue | null {
  const mark = emoji.trim();
  if (!mark) return null;
  if (mark.length > EMOJI_MAX || /\s/.test(mark)) return 'invalid';
  return null;
}

/** Null when the choice is empty or acceptable. */
export function botAvatarIssue(emoji: string, imageUrl: string): BotAvatarIssue | null {
  const picture = imageUrl.trim();
  if (picture) return isHttpUrl(picture) ? null : 'invalid';
  return emojiIssue(emoji);
}

export type BotCreateFace = {
  shape: string | null;
  color: string | null;
  style?: 'classic' | 'soft' | null;
  expression?: string | null;
};

export type BotCreateFields = {
  name: string;
  title: string;
  description: string;
  emoji: string;
  imageUrl: string;
  face: BotCreateFace;
};

export type BotCreatePayload = {
  name: string;
  title?: string;
  description?: string;
  faceShape?: string;
  faceColor?: string;
  faceStyle?: 'classic' | 'soft';
  faceExpression?: string;
  avatar?: string;
};

function optionalText(value: string): string | undefined {
  return value.trim() || undefined;
}

function withOptional<T extends object>(body: T, key: string, value: string | null | undefined): T {
  if (!value) return body;
  return { ...body, [key]: value };
}

/** Body for POST /api/bots. Blank optional fields are omitted. */
export function buildBotCreatePayload(fields: BotCreateFields): BotCreatePayload {
  const named = withOptional({ name: fields.name.trim() }, 'title', optionalText(fields.title));
  const described = withOptional(named, 'description', optionalText(fields.description));
  const faced = withOptional(described, 'faceShape', fields.face.shape);
  const colored = withOptional(faced, 'faceColor', fields.face.color);
  const styled = withOptional(colored, 'faceStyle', fields.face.style === 'soft' ? 'soft' : null);
  const expressed = withOptional(styled, 'faceExpression', fields.face.style === 'soft' ? fields.face.expression : null);
  return withOptional(expressed, 'avatar', botAvatarValue(fields.emoji, fields.imageUrl));
}

/** The daemon may return `{ bot }` or the bot itself. */
export function unwrapCreatedBot<T extends { id?: string }>(data: { bot?: T } | T | null | undefined): T {
  if (data && typeof data === 'object' && 'bot' in data && data.bot) return data.bot;
  return data as T;
}

/** Submit stays disabled until the name is usable and the avatar choice is valid. */
export function botCreateReady(name: string, nameProblem: string | null, avatarProblem: string | null, busy: boolean): boolean {
  return !busy && Boolean(name.trim()) && nameProblem === null && avatarProblem === null;
}

export type BotCreateBlock = 'name-empty' | 'name-taken' | 'avatar' | null;

/** The first reason a create submit must stop, or null when the body can be sent. */
export function botCreateBlock(nameProblem: 'empty' | 'taken' | null, avatarProblem: string | null): BotCreateBlock {
  if (nameProblem === 'empty') return 'name-empty';
  if (nameProblem === 'taken') return 'name-taken';
  if (avatarProblem) return 'avatar';
  return null;
}

/** Clicking the selected emoji clears it; clicking another selects it. */
export function nextAvatarEmoji(current: string, mark: string): string {
  return current === mark ? '' : mark;
}

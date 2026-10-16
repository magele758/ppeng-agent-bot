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

/** Null when the choice is empty or acceptable. */
export function botAvatarIssue(emoji: string, imageUrl: string): BotAvatarIssue | null {
  const picture = imageUrl.trim();
  if (picture) return isHttpUrl(picture) ? null : 'invalid';
  const mark = emoji.trim();
  if (!mark) return null;
  if (mark.length > EMOJI_MAX || /\s/.test(mark)) return 'invalid';
  return null;
}

/**
 * Per-Bot thinking effort pin. Stored as `metadata.thinkingEffort` on the
 * Bot's canonical chats, next to modelOverride. Absent means "follow the
 * global thinking effort setting". Any saved level, `off` included, wins over
 * the global level — `off` lets a Bot pinned to a model without effort support
 * opt out while the global setting asks other chats to think.
 */

import { ValidationError } from '../errors.js';
import { isThinkingEffortLevel, type ThinkingEffortLevel } from '../model/thinking-effort-settings.js';

export const BOT_THINKING_EFFORT_META = 'thinkingEffort';

/** `null` / `''` clears the pin ("follow global"); otherwise off | low | medium | high. */
export function normalizeBotThinkingEffort(raw: unknown): ThinkingEffortLevel | null {
  if (raw === null || raw === '') return null;
  if (isThinkingEffortLevel(raw)) return raw;
  throw new ValidationError('thinkingEffort must be null, off, low, medium, or high');
}

/** Pinned level on a Bot chat, or undefined when it follows the global setting. */
export function readBotThinkingEffort(
  metadata: Record<string, unknown> | undefined
): ThinkingEffortLevel | undefined {
  const raw = metadata?.[BOT_THINKING_EFFORT_META];
  return isThinkingEffortLevel(raw) ? raw : undefined;
}

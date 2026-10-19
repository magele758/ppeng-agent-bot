import { ValidationError } from '../errors.js';
import type { MessageReplyTo } from '../types.js';

export const REPLY_EXCERPT_MAX = 120;

/** Keep messageId, botId, and a short excerpt. Drop any quoted body the caller attached. */
export function normalizeReplyQuote(raw: unknown): MessageReplyTo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('replyTo must include messageId and excerpt');
  }
  const body = raw as Record<string, unknown>;
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
  const excerpt = typeof body.excerpt === 'string' ? body.excerpt.trim() : '';
  if (!messageId) throw new ValidationError('replyTo.messageId is required');
  if (!excerpt) throw new ValidationError('replyTo.excerpt is required');
  if ([...excerpt].length > REPLY_EXCERPT_MAX) {
    throw new ValidationError('replyTo.excerpt must be at most 120 characters');
  }
  if (body.botId === undefined || body.botId === null) return { messageId, excerpt };
  if (typeof body.botId !== 'string' || !body.botId.trim()) {
    throw new ValidationError('replyTo.botId must be a bot id');
  }
  return { messageId, botId: body.botId.trim(), excerpt };
}

export function replyToFromColumn(raw: unknown): MessageReplyTo | undefined {
  if (typeof raw !== 'string' || !raw || raw === 'null') return undefined;
  try {
    return normalizeReplyQuote(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

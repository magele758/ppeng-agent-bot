/**
 * Canonical bot chats compact on two fractions of the model window.
 * Ordinary chats stay on the derived history budget in session-budget.ts.
 * Ratios are constants: no new RAW_AGENT_* switch.
 */

import { CANONICAL_BOT_CHAT_META } from '../bots/types.js';
import type { SessionMessage } from '../types.js';

export const BOT_STRUCTURED_COMPACT_RATIO = 0.5;
export const BOT_HYGIENE_COMPACT_RATIO = 0.85;
/** Structured compact keeps the same recent tail as ordinary auto-compact. */
export const BOT_HYGIENE_KEEP_RECENT = 8;
export const BOT_TOOL_PRUNE_MIN_CHARS = 500;
export const BOT_TOOL_PRUNE_KEEP_CHARS = 400;

export const BOT_STRUCTURED_SECTIONS = [
  'Goal',
  'Constraints',
  'Progress',
  'Decisions',
  'Files',
  'Next steps'
] as const;

export type BotCompactTier = 'structured' | 'hygiene';

export function isCanonicalBotChat(session: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  return session.metadata?.[CANONICAL_BOT_CHAT_META] === true;
}

export function botCompactTokenThresholds(maxContextTokens: number): {
  structuredTokens: number;
  hygieneTokens: number;
} {
  const windowTokens = Math.max(1, Math.floor(maxContextTokens));
  return {
    structuredTokens: Math.floor(windowTokens * BOT_STRUCTURED_COMPACT_RATIO),
    hygieneTokens: Math.floor(windowTokens * BOT_HYGIENE_COMPACT_RATIO)
  };
}

/** Highest tier that applies. Overflow force still compacts, using structured when under 85%. */
export function selectBotCompactTier(
  estimatedTokens: number,
  thresholds: { structuredTokens: number; hygieneTokens: number },
  force = false
): BotCompactTier | null {
  if (estimatedTokens >= thresholds.hygieneTokens) return 'hygiene';
  if (estimatedTokens >= thresholds.structuredTokens || force) return 'structured';
  return null;
}

export function botCompactInstruction(tier: BotCompactTier, priorSummary?: string): string {
  const prior = priorSummary?.trim() ?? '';
  let head: string;
  switch (tier) {
    case 'structured':
      head = [
        'Structured compaction for a continuing bot chat.',
        'Write a continuation summary with exactly these sections:',
        ...BOT_STRUCTURED_SECTIONS.map((section) => `- ${section}`)
      ].join('\n');
      break;
    case 'hygiene':
      head = [
        'Session hygiene compaction for a continuing bot chat.',
        'This is the safety-net pass. Drop stale tool chatter and keep only the active task.'
      ].join('\n');
      break;
    default: {
      const unreachable: never = tier;
      return unreachable;
    }
  }
  if (!prior) return head;
  return [
    head,
    'A summary already exists. Update it incrementally. Do not rewrite the full history from scratch.',
    'Existing summary:',
    prior
  ].join('\n');
}

/** Shorten large tool outputs in the span about to be summarized. Does not touch the kept tail. */
export function pruneLargeToolOutputs(messages: readonly SessionMessage[]): SessionMessage[] {
  return messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== 'tool_result' || part.content.length < BOT_TOOL_PRUNE_MIN_CHARS) return part;
      changed = true;
      const dropped = part.content.length - BOT_TOOL_PRUNE_KEEP_CHARS;
      return {
        ...part,
        content: `${part.content.slice(0, BOT_TOOL_PRUNE_KEEP_CHARS)}\n…[pruned ${dropped} chars]`
      };
    });
    return changed ? { ...message, parts } : message;
  });
}

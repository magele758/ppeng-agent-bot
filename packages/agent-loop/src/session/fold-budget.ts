/**
 * Fold visible-history budget.
 *
 * Under the token budget the message-count cap is not a tail slice: the latest
 * user message stays even when the fold is longer than MAX_VISIBLE_MESSAGES.
 * Over the budget, drop only whole closed tool waves and always keep the
 * leading system prompt plus the latest user message.
 */

import { estimateMessageTokens } from '../model/token-estimate.js';
import type { SessionMessage } from '../types.js';
import { envInt } from '../helpers.js';
import { resolveHistoryTokenBudget } from './session-budget.js';

export const MAX_VISIBLE_MESSAGES = 24;

/**
 * Keep-recent clamp used by closed-prefix compact:
 * never keep the entire fold, never keep more than `keepRecent`.
 */
export function clampFoldKeepRecent(length: number, keepRecent: number): number {
  return Math.min(keepRecent, Math.max(1, length - 1));
}

export interface ClampFoldOptions {
  /**
   * Historical count cap. Ignored while the fold is under `tokenBudget`;
   * a cut never tail-slices to this length.
   */
  maxVisible?: number;
  /** History token budget. Omit to derive the compact threshold. */
  tokenBudget?: number;
  maxContextTokens?: number;
  env?: NodeJS.ProcessEnv;
}

function toolCallIds(message: SessionMessage): string[] {
  const ids: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'tool_call') ids.push(part.toolCallId);
  }
  return ids;
}

function toolResultIds(message: SessionMessage): string[] {
  const ids: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'tool_result') ids.push(part.toolCallId);
  }
  return ids;
}

/** Assistant tool_calls plus the following messages that close them. */
function atomicRanges(messages: readonly SessionMessage[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < messages.length) {
    const calls = new Set(toolCallIds(messages[i]!));
    if (messages[i]!.role === 'assistant' && calls.size > 0) {
      let j = i + 1;
      while (j < messages.length && calls.size > 0) {
        const msg = messages[j]!;
        const nextCalls = toolCallIds(msg);
        if (msg.role === 'user' || (msg.role === 'assistant' && nextCalls.length > 0)) break;
        let matched = false;
        for (const id of toolResultIds(msg)) {
          if (calls.delete(id)) matched = true;
        }
        if (!matched && msg.role !== 'tool') break;
        j += 1;
      }
      ranges.push({ start: i, end: j });
      i = j;
      continue;
    }
    ranges.push({ start: i, end: i + 1 });
    i += 1;
  }
  return ranges;
}

function leadingSystemCount(messages: readonly SessionMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i]!.role === 'system') i += 1;
  return i;
}

function latestUserIndex(messages: readonly SessionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

function collectRanges(
  messages: readonly SessionMessage[],
  ranges: ReadonlyArray<{ start: number; end: number }>,
  dropped: ReadonlySet<number>
): SessionMessage[] {
  const out: SessionMessage[] = [];
  ranges.forEach((range, idx) => {
    if (dropped.has(idx)) return;
    for (let i = range.start; i < range.end; i += 1) out.push(messages[i]!);
  });
  return out;
}

/** Drop tool messages whose assistant tool_calls are no longer in the view. */
function stripOrphanToolMessages(messages: readonly SessionMessage[]): SessionMessage[] {
  const open = new Set<string>();
  const out: SessionMessage[] = [];
  for (const message of messages) {
    const calls = toolCallIds(message);
    const results = toolResultIds(message);
    const orphan =
      message.role === 'tool' &&
      calls.length === 0 &&
      results.length > 0 &&
      results.every((id) => !open.has(id));
    if (orphan) continue;
    for (const id of calls) open.add(id);
    for (const id of results) open.delete(id);
    out.push(message);
  }
  return out;
}

/**
 * Drop oldest non-pinned closed waves until the estimate fits.
 * Leading system messages and the latest user message are never dropped.
 */
function fitFoldToClosedWaves(
  messages: readonly SessionMessage[],
  tokenBudget: number
): SessionMessage[] {
  const ranges = atomicRanges(messages);
  const systemCount = leadingSystemCount(messages);
  const userIdx = latestUserIndex(messages);
  const pinned = ranges.map(
    (range) => range.start < systemCount || (userIdx >= range.start && userIdx < range.end)
  );
  const dropped = new Set<number>();
  const tokensOf = () => estimateMessageTokens(collectRanges(messages, ranges, dropped));
  while (tokensOf() >= tokenBudget) {
    const next = ranges.findIndex((_, idx) => !dropped.has(idx) && !pinned[idx]);
    if (next < 0) break;
    dropped.add(next);
  }
  return stripOrphanToolMessages(collectRanges(messages, ranges, dropped));
}

/**
 * Visible-history clamp.
 *
 * Under the token budget, return a copy of the whole fold. The count cap must
 * not hard-slice to `maxVisible` and must not drop the latest user message.
 * Over the budget, keep the original system prompt and the latest user message
 * and drop only closed tool waves — never a blind tail slice.
 */
export function clampFoldToVisible(
  folded: readonly SessionMessage[],
  maxVisibleOrOpts: number | ClampFoldOptions = MAX_VISIBLE_MESSAGES
): SessionMessage[] {
  const opts: ClampFoldOptions =
    typeof maxVisibleOrOpts === 'number' ? { maxVisible: maxVisibleOrOpts } : maxVisibleOrOpts;
  const copy = folded.slice();
  if (copy.length === 0) return copy;
  const tokenBudget =
    opts.tokenBudget ??
    resolveHistoryTokenBudget(
      'RAW_AGENT_COMPACT_TOKEN_THRESHOLD',
      { maxContextTokens: opts.maxContextTokens },
      opts.env ?? process.env
    );
  if (estimateMessageTokens(copy) < tokenBudget) return copy;
  return fitFoldToClosedWaves(copy, tokenBudget);
}

export function capRollingSummaryText(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `…[earlier summary truncated]\n\n${text.slice(-maxChars)}`;
}

/**
 * 摘要字符上限：未设置 RAW_AGENT_COMPACT_SUMMARY_MAX_CHARS 时 = 阈值×2
 *（est≈len/4，约为阈值一半预算给摘要，余量给最近 N 条）。
 */
export function compactSummaryMaxChars(env: NodeJS.ProcessEnv, tokenThreshold: number): number {
  return envInt(env, 'RAW_AGENT_COMPACT_SUMMARY_MAX_CHARS', tokenThreshold * 2);
}

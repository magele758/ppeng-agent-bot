/**
 * Per-shot protocol recovery.
 * Absorbed from ppeng-agent-core turn/turn-recovery.ts.
 */

import { isToolUseFinish } from '../model/stop-reason.js';
import { isTruncatedFinish } from '../model/usage.js';
import type { MessagePart } from '../types.js';

export const MAX_TRUNCATION_CONTINUES = 2;
export const MAX_PROTOCOL_RETRIES = 2;
export const MAX_EMPTY_RETRIES = 2;
export const MAX_CRITICAL_HITS = 2;

export type RecoveryAction =
  | { action: 'continue' }
  | { action: 'retry-same-input' }
  | { action: 'retry-after-nudge'; nudge: string; discardAssistant?: boolean }
  | { action: 'end' }
  | { action: 'abort'; reason: string; discardAssistant?: boolean };

export interface TurnRecoveryState {
  truncatedContinues: number;
  protocolRetries: number;
  emptyRetries: number;
  criticalHits: number;
}

export function createTurnRecoveryState(): TurnRecoveryState {
  return { truncatedContinues: 0, protocolRetries: 0, emptyRetries: 0, criticalHits: 0 };
}

export function toolCallParts(parts: MessagePart[]): Extract<MessagePart, { type: 'tool_call' }>[] {
  return parts.filter((p): p is Extract<MessagePart, { type: 'tool_call' }> => p.type === 'tool_call');
}

export function isIncompleteToolCall(part: Extract<MessagePart, { type: 'tool_call' }>): boolean {
  if (!part.name || !part.toolCallId) return true;
  const keys = part.input && typeof part.input === 'object' ? Object.keys(part.input) : [];
  return keys.length === 0 && part.name.length === 0;
}

export function hasIncompleteToolCalls(parts: MessagePart[]): boolean {
  const calls = toolCallParts(parts);
  return calls.some((c) => !c.toolCallId || !c.name);
}

export function hasAssistantText(parts: MessagePart[]): boolean {
  return parts.some((p) => (p.type === 'text' || p.type === 'reasoning') && p.text.trim().length > 0);
}

export function finishAskedForTools(finishReason?: string, stopReason?: string): boolean {
  if (stopReason === 'tool_use') return true;
  return isToolUseFinish(finishReason);
}

/**
 * Tag-start only: prose discussion of these tags must not look like a leak.
 * Covers Anthropic antml, MiniMax, DSML, and bare invoke.
 */
export const TOOL_CALL_LEAK_PATTERNS: readonly RegExp[] = [
  /<\s*antml:(?:invoke|function_calls|parameter)\b/i,
  /<\s*invoke\s+name\s*=/i,
  /<\s*\/?\s*(?:tool_calls?|function_calls)\s*>/i,
  /<\s*[|｜]?DSML[|｜]?/i,
  /<\/?minimax:/i,
];

export const TOOL_CALL_LEAK_RE = /<\s*antml:(?:invoke|function_calls|parameter)\b|<\s*invoke\s+name\s*=|<\s*\/?\s*(?:tool_calls?|function_calls)\s*>|<\s*[|｜]?DSML[|｜]?|<\/?minimax:/i;

export function assistantHasToolCallLeak(parts: MessagePart[]): boolean {
  return parts.some(
    (p) =>
      (p.type === 'text' || p.type === 'reasoning') &&
      TOOL_CALL_LEAK_PATTERNS.some((re) => re.test(p.text ?? ''))
  );
}

export function discardedAssistant(recovery: RecoveryAction): boolean {
  return (
    (recovery.action === 'retry-after-nudge' || recovery.action === 'abort') &&
    recovery.discardAssistant === true
  );
}

function emptyUnparsedToolNudge(): string {
  return (
    '[recovery] Tool calls must use the structured tool_call channel; ' +
    'tool-call markup written in the reply text or thinking is ignored and was discarded. ' +
    'Retry the same turn: either emit a real tool call or answer directly.'
  );
}

function retryAsEmpty(
  state: TurnRecoveryState,
  opts: { nudge: string; abortReason?: string; discardAssistant?: boolean }
): RecoveryAction {
  const abortReason = opts.abortReason ?? 'empty_assistant';
  if (state.emptyRetries < MAX_EMPTY_RETRIES) {
    state.emptyRetries += 1;
    return {
      action: 'retry-after-nudge',
      nudge: opts.nudge,
      ...(opts.discardAssistant ? { discardAssistant: true } : {}),
    };
  }
  return {
    action: 'abort',
    reason: abortReason,
    ...(opts.discardAssistant ? { discardAssistant: true } : {}),
  };
}

export interface DecideTurnRecoveryInput {
  stopReason: string;
  finishReason?: string;
  truncated?: boolean;
  assistantParts: MessagePart[];
  state: TurnRecoveryState;
  userAborted?: boolean;
  contentFilter?: boolean;
}

export function decideTurnRecovery(input: DecideTurnRecoveryInput): RecoveryAction {
  if (input.userAborted) {
    return { action: 'abort', reason: 'user_abort' };
  }

  const parts = input.assistantParts ?? [];
  const truncated = input.truncated === true || isTruncatedFinish(input.finishReason);
  const calls = toolCallParts(parts);
  const empty = parts.length === 0 || (!hasAssistantText(parts) && calls.length === 0);
  const filtered =
    input.contentFilter === true ||
    (input.finishReason ?? '').toLowerCase().includes('content_filter');

  if (filtered) {
    return retryAsEmpty(input.state, {
      nudge: '[recovery] Previous reply was empty or filtered. Retry with a concise answer.',
      abortReason: 'content_filter',
    });
  }
  if (empty) {
    return retryAsEmpty(input.state, {
      nudge: '[recovery] Previous reply was empty or filtered. Retry with a concise answer.',
    });
  }

  if (
    calls.length === 0 &&
    (finishAskedForTools(input.finishReason, input.stopReason) ||
      assistantHasToolCallLeak(parts))
  ) {
    return retryAsEmpty(input.state, {
      nudge: emptyUnparsedToolNudge(),
      abortReason: 'empty_assistant',
      discardAssistant: true,
    });
  }

  if (truncated) {
    // Even parseable calls belong to an unfinished shot: later parallel calls or
    // argument deltas may have been cut off. Retry before persisting any wave.
    if (calls.length > 0) {
      if (input.state.protocolRetries < MAX_PROTOCOL_RETRIES) {
        input.state.protocolRetries += 1;
        return { action: 'retry-same-input' };
      }
      return { action: 'abort', reason: 'truncated_tool_call' };
    }
    if (input.state.truncatedContinues < MAX_TRUNCATION_CONTINUES) {
      input.state.truncatedContinues += 1;
      return {
        action: 'retry-after-nudge',
        nudge: '[recovery] Output was truncated. Continue the reply from the last sentence; do not restart.',
      };
    }
    return { action: 'end' };
  }

  if (input.stopReason === 'tool_use' || calls.length > 0) {
    return { action: 'continue' };
  }
  return { action: 'end' };
}

export function noteCriticalHit(state: TurnRecoveryState): RecoveryAction | { action: 'continue' } {
  state.criticalHits += 1;
  if (state.criticalHits >= MAX_CRITICAL_HITS) {
    return { action: 'abort', reason: 'loop_guard_critical' };
  }
  return { action: 'continue' };
}

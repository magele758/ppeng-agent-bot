/**
 * User-visible text copied onto session traces.
 * Head/tail clip matches the tool-result limit in agent-loop (`truncateToolContent`).
 */

import { MEMORY_CONTEXT_APPENDIX_PREFIX, isMemoryContextAppendixText } from '../memory/memory-gate.js';

export const TRACE_VISIBLE_MAX_CHARS = 120_000;

const TOOL_OBSERVATION_PREFIX = '[Tool observations:';

export function clipTraceText(text: string, maxChars = TRACE_VISIBLE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return text.slice(0, half) + `\n\n[… ${text.length - maxChars} chars truncated …]\n\n` + text.slice(-half);
}

export function traceVisibleText(text: string, redact?: (value: string) => string): string {
  const cleaned = redact ? redact(text) : text;
  return clipTraceText(cleaned);
}

type TextPart = { type: string; text?: string };
type VisibleMessage = { role: string; parts: TextPart[] };

function textOf(part: TextPart): string {
  return typeof part.text === 'string' ? part.text : '';
}

function isUserVisibleText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isMemoryContextAppendixText(trimmed)) return false;
  if (trimmed.startsWith(MEMORY_CONTEXT_APPENDIX_PREFIX)) return false;
  if (trimmed.startsWith(TOOL_OBSERVATION_PREFIX)) return false;
  return true;
}

/** Latest user-visible message. Skips system prompts, memory appendix, and tool-observation notes. */
export function visibleUserTurnText(messages: readonly VisibleMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const texts = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => textOf(part))
      .filter(isUserVisibleText);
    if (texts.length > 0) return texts.join('\n');
  }
  return '';
}

/** Assistant text the user can read. Reasoning is included only when there is no text part. */
export function visibleAssistantText(
  parts: readonly TextPart[],
  options?: { includeReasoning?: boolean }
): string {
  const texts = parts.filter((part) => part.type === 'text').map((part) => textOf(part)).filter((text) => text.length > 0);
  if (texts.length > 0) return texts.join('');
  if (!options?.includeReasoning) return '';
  return parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => textOf(part))
    .filter((text) => text.length > 0)
    .join('');
}

export function turnTraceFields(input: {
  messages: readonly VisibleMessage[];
  assistantParts?: readonly TextPart[];
  includeReasoning?: boolean;
  redact?: (value: string) => string;
}): { userText?: string; assistantText?: string } {
  const userText = traceVisibleText(visibleUserTurnText(input.messages), input.redact);
  const assistantText = traceVisibleText(
    visibleAssistantText(input.assistantParts ?? [], { includeReasoning: input.includeReasoning }),
    input.redact
  );
  return {
    ...(userText ? { userText } : {}),
    ...(assistantText ? { assistantText } : {})
  };
}

export function repetitionTraceFields(
  sample: string,
  redact?: (value: string) => string
): { text?: string } {
  const text = traceVisibleText(sample, redact);
  return text ? { text } : {};
}

export function attachGoalText(
  payload: Record<string, unknown>,
  judged: { goal?: string; title?: string }
): Record<string, unknown> {
  const goal = judged.goal?.trim() ?? '';
  const title = judged.title?.trim() ?? '';
  const sentence = goal || title;
  const out: Record<string, unknown> = { ...payload };
  if (sentence) out.goal = sentence;
  if (title && title !== sentence) out.title = title;
  return out;
}

export function childSessionTrace(
  childSessionId: string,
  source: string
): { kind: 'child_session'; payload: Record<string, unknown> } {
  return { kind: 'child_session', payload: { childSessionId, source } };
}

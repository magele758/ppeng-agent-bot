/**
 * Final model-request cap for ordinary chats.
 *
 * Measured after micro-compact, on the request that will actually be sent:
 * system prompt + tool schemas + messages. The cap is a constant fraction of
 * the resolved context window. No new RAW_AGENT_* switch.
 *
 * Canonical bot chats do not use this module; they stay on the 50% / 85%
 * compact path in bot-compact-policy.ts.
 */

import { estimateMessageTokens, estimateTokensFromText } from '../model/token-estimate.js';
import type { SessionMessage } from '../types.js';

export const NORMAL_SESSION_REQUEST_RATIO = 0.2;

export interface CountedToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface NormalRequestMeasureInput {
  systemPrompt: string;
  tools: readonly CountedToolSchema[];
  messages: SessionMessage[];
  maxContextTokens: number;
}

export interface NormalRequestFit {
  messages: SessionMessage[];
  requestTokens: number;
  capTokens: number;
  windowTokens: number;
  pinnedTokens: number;
  pinnedOverBudget: boolean;
  /** Older prefix to summarize. Null when the request can be sent as fitted. */
  summarizePrefix: SessionMessage[] | null;
  /** Leading system messages plus the latest user and anything kept after it. */
  summaryKept: SessionMessage[] | null;
}

export function normalRequestCapTokens(
  maxContextTokens: number,
  ratio: number = NORMAL_SESSION_REQUEST_RATIO
): number {
  const windowTokens = Math.max(1, Math.floor(maxContextTokens));
  const safeRatio = ratio > 0 && ratio <= 1 ? ratio : NORMAL_SESSION_REQUEST_RATIO;
  return Math.floor(windowTokens * safeRatio);
}

export function estimateToolSchemaTokens(tools: readonly CountedToolSchema[]): number {
  if (tools.length === 0) return 0;
  const payload = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? {}
    }
  }));
  return estimateTokensFromText(JSON.stringify(payload));
}

export function estimateNormalRequestTokens(
  input: Pick<NormalRequestMeasureInput, 'systemPrompt' | 'tools' | 'messages'>
): number {
  const system = input.systemPrompt ? estimateTokensFromText(input.systemPrompt) : 0;
  return system + estimateToolSchemaTokens(input.tools) + estimateMessageTokens(input.messages);
}

/** Shrink summary text until its own token estimate fits `maxTokens`. */
export function capSummaryToTokens(summary: string, maxTokens: number): string {
  const trimmed = summary.trim();
  if (!trimmed || maxTokens <= 0) return '';
  if (estimateTokensFromText(trimmed) <= maxTokens) return trimmed;
  let lo = 0;
  let hi = trimmed.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = trimmed.slice(trimmed.length - mid);
    if (estimateTokensFromText(slice) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '' : trimmed.slice(trimmed.length - lo);
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

function pinnedMessages(messages: readonly SessionMessage[]): SessionMessage[] {
  const leading = messages.slice(0, leadingSystemCount(messages)).filter(message => message.key !== 'compact-summary');
  const userIdx = latestUserIndex(messages);
  if (userIdx < 0) return leading.slice();
  return [...leading, messages[userIdx]!];
}

/** A closed assistant tool_call plus the following messages that resolve it. */
function closedWaveAt(
  messages: readonly SessionMessage[],
  index: number
): { start: number; end: number } | null {
  const message = messages[index];
  if (!message || message.role !== 'assistant') return null;
  const calls = toolCallIds(message);
  if (calls.length === 0) return null;
  const pending = new Set(calls);
  let cursor = index + 1;
  while (cursor < messages.length && pending.size > 0) {
    const next = messages[cursor]!;
    if (next.role === 'user') return null;
    if (next.role === 'assistant' && toolCallIds(next).length > 0) return null;
    const results = toolResultIds(next);
    if (results.length === 0) return null;
    let matched = false;
    for (const id of results) {
      if (pending.delete(id)) matched = true;
    }
    if (!matched) return null;
    cursor += 1;
  }
  if (pending.size > 0) return null;
  return { start: index, end: cursor };
}

function oldestClosedWave(messages: readonly SessionMessage[]): { start: number; end: number } | null {
  const userIdx = latestUserIndex(messages);
  for (let i = 0; i < messages.length; i += 1) {
    const wave = closedWaveAt(messages, i);
    if (!wave) continue;
    if (userIdx >= wave.start && userIdx < wave.end) continue;
    return wave;
  }
  return null;
}

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

function dropOlderClosedToolWaves(
  messages: readonly SessionMessage[],
  stillOver: (next: SessionMessage[]) => boolean
): SessionMessage[] {
  let current = messages.slice();
  while (stillOver(current)) {
    const wave = oldestClosedWave(current);
    if (!wave) break;
    current = [...current.slice(0, wave.start), ...current.slice(wave.end)];
  }
  return stripOrphanToolMessages(current);
}

function prefixBeforeLatestUser(messages: readonly SessionMessage[]): {
  prefix: SessionMessage[];
  kept: SessionMessage[];
} {
  const leading = leadingSystemCount(messages);
  const userIdx = latestUserIndex(messages);
  const systems = messages.slice(0, leading);
  const rolling = systems.filter(message => message.key === 'compact-summary');
  const protectedSystems = systems.filter(message => message.key !== 'compact-summary');
  if (userIdx < 0) {
    return { prefix: [...rolling, ...messages.slice(leading)], kept: protectedSystems };
  }
  return {
    prefix: [...rolling, ...messages.slice(leading, userIdx)],
    kept: [...protectedSystems, ...messages.slice(userIdx)]
  };
}

export function fitNormalSessionRequest(input: NormalRequestMeasureInput): NormalRequestFit {
  const windowTokens = Math.max(1, Math.floor(input.maxContextTokens));
  const capTokens = normalRequestCapTokens(windowTokens);
  const requestTokens = estimateNormalRequestTokens(input);
  const pinned = pinnedMessages(input.messages);
  const pinnedTokens = estimateNormalRequestTokens({ ...input, messages: pinned });
  const base = { capTokens, windowTokens, pinnedTokens };

  if (requestTokens <= capTokens) {
    return {
      ...base,
      messages: input.messages,
      requestTokens,
      pinnedOverBudget: false,
      summarizePrefix: null,
      summaryKept: null
    };
  }

  if (pinnedTokens > capTokens) {
    return {
      ...base,
      messages: input.messages,
      requestTokens,
      pinnedOverBudget: true,
      summarizePrefix: null,
      summaryKept: null
    };
  }

  const trimmed = dropOlderClosedToolWaves(input.messages, (next) => {
    return estimateNormalRequestTokens({ ...input, messages: next }) > capTokens;
  });
  const trimmedTokens = estimateNormalRequestTokens({ ...input, messages: trimmed });
  if (trimmedTokens <= capTokens) {
    return {
      ...base,
      messages: trimmed,
      requestTokens: trimmedTokens,
      pinnedOverBudget: false,
      summarizePrefix: null,
      summaryKept: null
    };
  }

  const split = prefixBeforeLatestUser(input.messages);
  if (split.prefix.length === 0) {
    return {
      ...base,
      messages: trimmed,
      requestTokens: trimmedTokens,
      pinnedOverBudget: false,
      summarizePrefix: null,
      summaryKept: null
    };
  }

  const keptSplit = prefixBeforeLatestUser(trimmed);
  return {
    ...base,
    messages: trimmed,
    requestTokens: trimmedTokens,
    pinnedOverBudget: false,
    summarizePrefix: split.prefix,
    summaryKept: keptSplit.kept
  };
}

/**
 * Micro-compaction (absorbed from ai-agent-node session/micro-compact.ts).
 *
 * Complements the threshold-driven `autoCompact` in the runtime, which only
 * fires once the whole transcript crosses a token budget and then pays for an
 * LLM summarization round. Micro-compaction is the cheap, every-turn half: tool
 * results the model has already acted on are the single largest source of dead
 * context, so keep the last N verbatim and collapse the older ones to a
 * one-line marker. Recent results still get a hard cap, otherwise a single 120k
 * `bash` dump keeps blowing up the window before any threshold trips.
 *
 * Pure over `SessionMessage[]` — returns a new array and never mutates stored
 * rows, so the persisted transcript stays complete and only the model's view
 * shrinks.
 */

import { envBool, envInt } from '../helpers.js';
import type { MessagePart, SessionMessage } from '../types.js';
import {
  formatToolResultStub,
  type ToolResultStubAddr
} from './tool-result-stub.js';

export {
  formatToolResultStub,
  isToolResultStub,
  parseToolResultStubRef,
  TOOL_RESULT_STUB_MARK
} from './tool-result-stub.js';
export type { ToolResultStubAddr, ToolResultStubRef } from './tool-result-stub.js';

/**
 * Which tool results are treated as stale.
 *
 * - `keep_recent` (default): keep the last N results verbatim.
 * - `after_any_assistant`: stub a result once any later assistant message exists
 *   (the model has already started a turn that saw that result).
 * - `after_text_assistant`: same, but only after a later assistant **text**
 *   part — tool-call-only turns do not evict. Safer for multi-step tool streaks.
 *
 * Chat Completions cannot yank tokens from an in-flight prompt. These policies
 * only shrink the **next** request's view; they are not mid-stream eviction.
 */
export type MicroCompactPolicy = 'keep_recent' | 'after_any_assistant' | 'after_text_assistant';

export interface MicroCompactConfig {
  enabled: boolean;
  /** Number of most recent tool results kept verbatim (`keep_recent` only). */
  keepRecent: number;
  /** Only replace outputs longer than this with a placeholder. */
  minChars: number;
  /** Hard cap applied even to kept (recent / unconsumed) tool results. */
  hardMaxChars: number;
  /**
   * Eviction rule. Default `keep_recent`. Not read from env — pass explicitly
   * (experiment / Lab settings) so we do not add another RAW_AGENT_* switch.
   */
  policy?: MicroCompactPolicy;
}

export const DEFAULT_MICRO_COMPACT_CONFIG: MicroCompactConfig = {
  enabled: true,
  keepRecent: 3,
  minChars: 100,
  hardMaxChars: 12_000,
  policy: 'keep_recent'
};

export function microCompactConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MicroCompactConfig {
  return {
    enabled: envBool(env, 'RAW_AGENT_MICRO_COMPACT', DEFAULT_MICRO_COMPACT_CONFIG.enabled),
    keepRecent: envInt(
      env,
      'RAW_AGENT_MICRO_COMPACT_KEEP_RECENT',
      DEFAULT_MICRO_COMPACT_CONFIG.keepRecent
    ),
    minChars: envInt(env, 'RAW_AGENT_MICRO_COMPACT_MIN_CHARS', DEFAULT_MICRO_COMPACT_CONFIG.minChars),
    hardMaxChars: envInt(
      env,
      'RAW_AGENT_MICRO_COMPACT_HARD_MAX_CHARS',
      DEFAULT_MICRO_COMPACT_CONFIG.hardMaxChars
    )
  };
}

/** Head+tail trim so both the command echo and the final lines survive. */
function hardTrim(content: string, name: string, hardMaxChars: number): string {
  if (content.length <= hardMaxChars) return content;
  const head = Math.max(500, Math.floor(hardMaxChars * 0.7));
  const tail = Math.max(200, hardMaxChars - head - 64);
  const dropped = content.length - head - tail;
  return [
    `[recent ${name} output trimmed from ${content.length} chars]`,
    content.slice(0, head),
    `…[${dropped} chars truncated]…`,
    content.slice(-tail)
  ].join('\n');
}

export interface MicroCompactStats {
  /** Tool results replaced by a placeholder. */
  collapsed: number;
  /** Recent tool results head/tail trimmed. */
  trimmed: number;
  /** Characters removed from the model's view. */
  charsSaved: number;
}

/** Stale tool output stand-in: tool name and ids stay; the line only says the output was omitted to save space. */
export function toolResultPlaceholder(name: string, ok: boolean, addr?: ToolResultStubAddr): string {
  return formatToolResultStub(name, ok, addr);
}

/** True if an assistant message after `afterMsgIdx` counts as "already consumed". */
export function assistantFollowsToolResult(
  messages: SessionMessage[],
  afterMsgIdx: number,
  requireText: boolean
): boolean {
  for (let i = afterMsgIdx + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    if (!requireText) return true;
    if (message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)) {
      return true;
    }
  }
  return false;
}

function shouldCollapse(
  config: MicroCompactConfig,
  resultIndex: number,
  keepFrom: number,
  messages: SessionMessage[],
  pos: { msg: number }
): boolean {
  const policy = config.policy ?? 'keep_recent';
  if (policy === 'after_any_assistant') {
    return assistantFollowsToolResult(messages, pos.msg, false);
  }
  if (policy === 'after_text_assistant') {
    return assistantFollowsToolResult(messages, pos.msg, true);
  }
  return resultIndex < keepFrom;
}

/**
 * Shrink stale tool results in a message list destined for the model.
 * Failed results are collapsed too — the model has already seen the error and
 * a repeated stack trace is exactly the kind of dead weight this removes.
 */
export function microCompactMessages(
  messages: SessionMessage[],
  config: MicroCompactConfig = microCompactConfigFromEnv()
): { messages: SessionMessage[]; stats: MicroCompactStats } {
  const stats: MicroCompactStats = { collapsed: 0, trimmed: 0, charsSaved: 0 };
  if (!config.enabled) return { messages, stats };

  // Flat index of every tool_result across the list, in transcript order.
  const positions: Array<{ msg: number; part: number }> = [];
  messages.forEach((message, msgIdx) => {
    message.parts.forEach((part, partIdx) => {
      if (part.type === 'tool_result') positions.push({ msg: msgIdx, part: partIdx });
    });
  });
  if (positions.length === 0) return { messages, stats };

  const keepFrom = Math.max(0, positions.length - Math.max(0, config.keepRecent));
  const rewrites = new Map<string, string>();

  positions.forEach((pos, idx) => {
    const part = messages[pos.msg]!.parts[pos.part]!;
    if (part.type !== 'tool_result') return;
    const original = part.content;

    if (shouldCollapse(config, idx, keepFrom, messages, pos)) {
      if (original.length > config.minChars) {
        const message = messages[pos.msg]!;
        const placeholder = toolResultPlaceholder(part.name, part.ok, {
          messageId: message.id,
          partIndex: pos.part,
          seq: message.seq
        });
        rewrites.set(`${pos.msg}:${pos.part}`, placeholder);
        stats.collapsed += 1;
        stats.charsSaved += original.length - placeholder.length;
      }
      return;
    }

    const trimmed = hardTrim(original, part.name, config.hardMaxChars);
    if (trimmed !== original) {
      rewrites.set(`${pos.msg}:${pos.part}`, trimmed);
      stats.trimmed += 1;
      stats.charsSaved += original.length - trimmed.length;
    }
  });

  if (rewrites.size === 0) return { messages, stats };

  const out = messages.map((message, msgIdx) => {
    if (!message.parts.some((_, partIdx) => rewrites.has(`${msgIdx}:${partIdx}`))) {
      return message;
    }
    const parts: MessagePart[] = message.parts.map((part, partIdx) => {
      const replacement = rewrites.get(`${msgIdx}:${partIdx}`);
      if (replacement === undefined || part.type !== 'tool_result') return part;
      return { ...part, content: replacement };
    });
    return { ...message, parts };
  });

  return { messages: out, stats };
}

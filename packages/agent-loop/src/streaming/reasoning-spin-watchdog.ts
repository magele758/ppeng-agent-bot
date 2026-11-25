/**
 * Reasoning-spin watchdog (absorbed from ai-agent-node streaming/).
 *
 * Real failure mode: a thinking model returns several turns in a row that carry
 * only `reasoning` (or nothing at all) — no tool call, no assistant text. Each
 * such turn re-sends the full system prompt + tool schemas, so the session burns
 * tens of thousands of prompt tokens making zero progress. `SessionLoopGuard`
 * misses it because every reasoning blob is textually different, so the
 * fingerprints never repeat.
 *
 * This module only classifies and counts. The caller stops the loop, and unlike
 * a repetition abort it must NOT re-ask the model: a retry would just burn
 * another full-tools prompt. Finalize gracefully instead.
 */

import { envBool, envInt } from '../helpers.js';
import type { MessagePart } from '../types.js';

export function reasoningSpinWatchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(env, 'RAW_AGENT_REASONING_SPIN_WATCHDOG', true);
}

export type ModelResponseKind = 'tool' | 'message' | 'reasoning_only' | 'empty';

export interface ReasoningSpinWatchdogConfig {
  /** Consecutive no-progress turns tolerated before aborting (inclusive). */
  maxConsecutiveNoProgress: number;
}

const DEFAULT_MAX = 3;

export function loadReasoningSpinWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env
): ReasoningSpinWatchdogConfig {
  return {
    maxConsecutiveNoProgress: envInt(env, 'RAW_AGENT_REASONING_SPIN_MAX', DEFAULT_MAX)
  };
}

/** Classify a turn's assistant parts into a progress kind. */
export function classifyAssistantParts(parts: MessagePart[]): ModelResponseKind {
  let hasTool = false;
  let messageText = '';
  let reasoningText = '';

  for (const part of parts) {
    if (part.type === 'tool_call') {
      hasTool = true;
    } else if (part.type === 'text') {
      messageText += part.text;
    } else if (part.type === 'reasoning') {
      reasoningText += part.text;
    }
  }

  if (hasTool) return 'tool';
  if (messageText.trim()) return 'message';
  if (reasoningText.trim()) return 'reasoning_only';
  return 'empty';
}

/**
 * Per-session spin counter. `note()` returns an abort reason once the streak of
 * reasoning-only / empty turns reaches the configured maximum.
 */
export class ReasoningSpinWatchdog {
  private consecutiveNoProgress = 0;

  constructor(private readonly config: ReasoningSpinWatchdogConfig = loadReasoningSpinWatchdogConfig()) {}

  get streak(): number {
    return this.consecutiveNoProgress;
  }

  note(kind: ModelResponseKind): string | null {
    if (kind === 'tool' || kind === 'message') {
      this.consecutiveNoProgress = 0;
      return null;
    }
    this.consecutiveNoProgress += 1;
    if (this.consecutiveNoProgress >= this.config.maxConsecutiveNoProgress) {
      return `${this.consecutiveNoProgress} consecutive turns produced only reasoning/empty output — no tool call and no assistant text (suspected reasoning spin)`;
    }
    return null;
  }

  noteParts(parts: MessagePart[]): string | null {
    return this.note(classifyAssistantParts(parts));
  }

  reset(): void {
    this.consecutiveNoProgress = 0;
  }

  restoreStreak(streak: number): void {
    this.consecutiveNoProgress = Math.max(0, Math.floor(streak));
  }
}

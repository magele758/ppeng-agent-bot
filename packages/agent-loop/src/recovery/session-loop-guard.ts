import type { MessagePart } from '../types.js';
import { envBool, envInt, fingerprintHash } from '../helpers.js';

export function recoveryPolicyEnabled(env: Record<string, string | undefined>): boolean {
  return envBool(env, 'RAW_AGENT_RECOVERY_POLICY', true);
}

/** One tool call in a round; `input` is `tool_call.input` (canonical args). */
export type LoopGuardToolCall = {
  name: string;
  input?: unknown;
};

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      },
      {} as Record<string, unknown>
    );
}

function fingerprintAssistant(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') chunks.push(`t:${p.text}`);
    else if (p.type === 'reasoning') chunks.push(`r:${p.text}`);
    else if (p.type === 'tool_call') {
      chunks.push(`c:${p.name}:${stableJsonForFingerprint(p.input)}`);
    }
  }
  return fingerprintHash(chunks.join('\n'));
}

function stableJsonForFingerprint(input: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(input));
  } catch {
    return String(input);
  }
}

/**
 * Fingerprint of one tool round: ordered sequence of (name, canonical args).
 *
 * We do not use the first tool name alone — that aborted varied bash work
 * (`ls` / `cat` / `grep`) as if it were a dead loop. The whole-round sequence
 * is the unit: a different command, a different tool set, or a different order
 * (`[bash, read_file]` ≠ `[read_file, bash]`) is a new fingerprint and resets
 * the content streak. Key order in args is normalized so `{a,b}` equals `{b,a}`.
 */
function fingerprintToolRound(toolCalls: LoopGuardToolCall[]): string {
  const chunks = toolCalls.map((tc) => `${tc.name}:${stableJsonForFingerprint(tc.input ?? {})}`);
  return fingerprintHash(chunks.join('\n'));
}

function summarizeToolRound(toolCalls: LoopGuardToolCall[]): string {
  const names = [...new Set(toolCalls.map((tc) => tc.name).filter(Boolean))];
  return names.length > 0 ? names.join(', ') : 'empty';
}

function repeatRatioFromEnv(env: Record<string, string | undefined>): number {
  const raw = Number(env.RAW_AGENT_RECOVERY_REPEAT_RATIO);
  if (!Number.isFinite(raw)) return 0.75;
  return Math.min(1, Math.max(0.5, raw));
}

/**
 * Per-session loop detection: tool failure streaks, same tool-call *content*
 * streak across turns, repeated assistant fingerprints (cheap dead-loop signal).
 */
export class SessionLoopGuard {
  private readonly toolFailStreak = new Map<string, number>();
  private lastToolRoundFingerprint = '';
  private sameCallStreak = 0;
  private readonly contentHashes: string[] = [];

  private readonly failStreakMax: number;
  private readonly sameToolStreakMax: number;
  private readonly repeatWindow: number;
  private readonly repeatRatio: number;

  constructor(env: Record<string, string | undefined>) {
    this.failStreakMax = envInt(env, 'RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK', 3);
    this.sameToolStreakMax = envInt(env, 'RAW_AGENT_RECOVERY_SAME_TOOL_STREAK', 5);
    this.repeatWindow = envInt(env, 'RAW_AGENT_RECOVERY_REPEAT_WINDOW', 8);
    this.repeatRatio = repeatRatioFromEnv(env);
  }

  /** After model returns; updates repetition window. */
  checkAssistantRepetition(assistantParts: MessagePart[]): { abort: true; reason: string } | { abort: false } {
    const fp = fingerprintAssistant(assistantParts);
    this.contentHashes.push(fp);
    if (this.contentHashes.length > this.repeatWindow) {
      this.contentHashes.shift();
    }
    const counts = new Map<string, number>();
    for (const h of this.contentHashes) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    let maxC = 0;
    for (const c of counts.values()) {
      maxC = Math.max(maxC, c);
    }
    const n = this.contentHashes.length;
    const ratio = n > 0 ? maxC / n : 0;
    if (n >= 4 && ratio >= this.repeatRatio) {
      return {
        abort: true,
        reason: `repeated model output (${(ratio * 100).toFixed(0)}% identical fingerprint in last ${n} turns)`
      };
    }
    return { abort: false };
  }

  /** After tool results are known; updates failure and same-call-content streaks. */
  afterToolRound(
    toolCalls: LoopGuardToolCall[],
    results: { name: string; ok: boolean }[]
  ): { abort: true; reason: string } | { abort: false } {
    for (const r of results) {
      if (!r.ok) {
        this.toolFailStreak.set(r.name, (this.toolFailStreak.get(r.name) ?? 0) + 1);
      } else {
        this.toolFailStreak.set(r.name, 0);
      }
    }
    for (const [name, streak] of this.toolFailStreak) {
      if (streak >= this.failStreakMax) {
        return { abort: true, reason: `tool "${name}" failed ${streak} times in a row` };
      }
    }

    // Empty rounds do not touch the content streak (same as the old "if first name" skip).
    if (toolCalls.length === 0) {
      return { abort: false };
    }

    const fp = fingerprintToolRound(toolCalls);
    if (fp === this.lastToolRoundFingerprint) {
      this.sameCallStreak += 1;
    } else {
      this.lastToolRoundFingerprint = fp;
      this.sameCallStreak = 1;
    }

    if (this.sameCallStreak >= this.sameToolStreakMax) {
      const label = summarizeToolRound(toolCalls);
      // Prefix is the user-visible repeat-detection marker. Kernels drop this abort
      // when repeatGuard is off, or the model is strong under the default `weak` mode.
      return {
        abort: true,
        reason: `repeat detection: same tool-call content in ${this.sameToolStreakMax} consecutive tool rounds (${label})`
      };
    }
    return { abort: false };
  }

  get sameToolStreak(): number {
    return this.sameCallStreak;
  }

  get sameToolThreshold(): number {
    return this.sameToolStreakMax;
  }
}

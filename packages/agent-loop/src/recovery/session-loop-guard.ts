import type { MessagePart } from '../types.js';
import { envBool, envInt, fingerprintHash } from '../helpers.js';

export function recoveryPolicyEnabled(env: Record<string, string | undefined>): boolean {
  return envBool(env, 'RAW_AGENT_RECOVERY_POLICY', true);
}

/** One tool call in a round; `input` is `tool_call.input` (canonical args). */
export type LoopGuardToolCall = {
  name: string;
  input?: unknown;
  toolCallId?: string;
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
 * is the unit: a different command, tool set or order has its own observation
 * history. Key order in args is normalized so `{a,b}` equals `{b,a}`.
 */
function fingerprintToolRound(toolCalls: LoopGuardToolCall[]): string {
  const chunks = toolCalls.map((tc) => `${tc.name}:${stableJsonForFingerprint(tc.input ?? {})}`);
  return fingerprintHash(chunks.join('\n'));
}

// Only transport/observation fields are noise; domain status, counters and evidence remain.
const OBSERVATION_NOISE = /^(timestamp|observedAt|fetchedAt|checkedAt|requestId|traceId|durationMs|elapsedMs)$/i;
function normalizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !OBSERVATION_NOISE.test(key)).map(([key, item]) => [key, normalizeEvidence(item)])
  );
  return value;
}
function evidenceFingerprint(results: { name: string; content?: string }[]): string | undefined {
  if (results.some(r => typeof r.content !== 'string' || !r.content.trim())) return undefined;
  return fingerprintHash(stableJsonForFingerprint(results.map(r => {
    let content: unknown = r.content;
    try { content = JSON.parse(r.content!); } catch { /* Plain-text tool output. */ }
    return { name: r.name, content: normalizeEvidence(content) };
  })));
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
  private sameCallStreak = 0;
  private readonly rounds = new Map<string, { seen: Set<string>; streak: number }>();
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
    // Tool requests cannot be judged until their observations arrive.
    if (assistantParts.some(p => p.type === 'tool_call')) return { abort: false };
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
    results: { name: string; ok: boolean; content?: string; toolCallId?: string }[]
  ): { abort: true; reason: string } | { abort: false } {
    for (const r of results) {
      if (!r.ok) {
        this.toolFailStreak.set(r.name, (this.toolFailStreak.get(r.name) ?? 0) + 1);
      } else {
        this.toolFailStreak.set(r.name, 0);
      }
    }
    // Empty rounds do not touch the content streak (same as the old "if first name" skip).
    if (toolCalls.length === 0) {
      return { abort: false };
    }

    const fp = fingerprintToolRound(toolCalls);
    const state = this.rounds.get(fp) ?? { seen: new Set<string>(), streak: 0 };
    state.streak++;
    this.rounds.delete(fp);
    this.rounds.set(fp, state);
    if (this.rounds.size > 128) this.rounds.delete(this.rounds.keys().next().value!);

    // Match by call ID when available; concurrent execution can reorder results.
    const remaining = [...results];
    const paired = toolCalls.map(call => {
      const index = remaining.findIndex(r => call.toolCallId ? r.toolCallId === call.toolCallId : r.name === call.name);
      return index < 0 ? undefined : remaining.splice(index, 1)[0];
    });
    const complete = results.length === toolCalls.length && paired.every((r, i) => r?.ok && r.name === toolCalls[i]?.name);
    const evidence = complete ? evidenceFingerprint(paired as typeof results) : undefined;
    if (evidence && !state.seen.has(evidence)) {
      // New evidence anywhere breaks a stagnant cycle, including interleaved calls.
      for (const round of this.rounds.values()) round.streak = 0;
      state.streak = 1;
      this.contentHashes.length = 0;
      state.seen.add(evidence);
      if (state.seen.size > 256) state.seen.delete(state.seen.values().next().value!);
    }
    this.sameCallStreak = state.streak;

    for (const [name, streak] of this.toolFailStreak) {
      if (streak >= this.failStreakMax) {
        return { abort: true, reason: `tool "${name}" failed ${streak} times in a row` };
      }
    }

    if (this.sameCallStreak >= this.sameToolStreakMax) {
      const label = summarizeToolRound(toolCalls);
      // Prefix is the user-visible repeat-detection marker. Kernels drop this abort
      // when repeatGuard is off, or the model is strong under the default `weak` mode.
      return {
        abort: true,
        reason: `repeat detection: same tool-call content in ${this.sameToolStreakMax} repeated tool rounds without new successful evidence (${label})`
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

/**
 * Intra-turn repetition watchdog (absorbed from ai-agent-node streaming/).
 *
 * Real failure mode: the model degenerates inside a single assistant message and
 * spams tokens (`覆盖覆盖覆盖…` hundreds of times). The cross-turn detectors in
 * `recovery/session-loop-guard.ts` are tool-centric and fingerprint whole turns,
 * so they see nothing until the turn ends — by then the context is already burnt.
 * An idle timeout does not help either: the stream never goes idle.
 *
 * Pure detector: the caller feeds accumulated stream text and aborts on a hit.
 * Conservative by design — min-length floor + high thresholds + whitespace
 * allowlist keep legitimate repetition (markdown rules, indentation) safe.
 */

import { envBool, envInt } from '../helpers.js';

export function repetitionWatchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(env, 'RAW_AGENT_STREAM_WATCHDOG', true);
}

/** Tail window examined; O(window) per call so per-chunk invocation stays cheap. */
const DEFAULT_WINDOW = 256;
/** Below this total length, repetition is usually legitimate ("ok ok"). */
const DEFAULT_MIN_TOTAL_LEN = 80;
/** Same character repeated more than this many times in the tail → degenerate. */
const DEFAULT_CHAR_RUN_THRESHOLD = 50;
/** Longest n-gram unit considered (2..N). */
const DEFAULT_MAX_NGRAM = 12;
/** Tail n-gram repeats must cover more than this fraction of the window. */
const DEFAULT_NGRAM_RATIO_THRESHOLD = 0.8;
/** Minimum consecutive n-gram repeats, so one long unit cannot trip it. */
const DEFAULT_NGRAM_MIN_REPEATS = 3;

export interface RepetitionWatchdogConfig {
  window: number;
  minTotalLen: number;
  charRunThreshold: number;
  maxNgram: number;
  ngramRatioThreshold: number;
  ngramMinRepeats: number;
}

function envRatio(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

export function loadRepetitionWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env
): RepetitionWatchdogConfig {
  return {
    window: envInt(env, 'RAW_AGENT_STREAM_WATCHDOG_WINDOW', DEFAULT_WINDOW),
    minTotalLen: envInt(env, 'RAW_AGENT_STREAM_WATCHDOG_MIN_LEN', DEFAULT_MIN_TOTAL_LEN),
    charRunThreshold: envInt(env, 'RAW_AGENT_STREAM_WATCHDOG_CHAR_RUN', DEFAULT_CHAR_RUN_THRESHOLD),
    maxNgram: envInt(env, 'RAW_AGENT_STREAM_WATCHDOG_MAX_NGRAM', DEFAULT_MAX_NGRAM),
    ngramRatioThreshold: envRatio(
      env,
      'RAW_AGENT_STREAM_WATCHDOG_NGRAM_RATIO',
      DEFAULT_NGRAM_RATIO_THRESHOLD
    ),
    ngramMinRepeats: envInt(
      env,
      'RAW_AGENT_STREAM_WATCHDOG_NGRAM_MIN_REPEATS',
      DEFAULT_NGRAM_MIN_REPEATS
    )
  };
}

function isWhitespaceOnly(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * Detect degenerate repetition in accumulated stream text.
 * @returns a human-readable reason on hit, else null.
 */
export function detectRepetitionLoop(
  text: string,
  config: RepetitionWatchdogConfig = loadRepetitionWatchdogConfig()
): string | null {
  if (!text || text.length < config.minTotalLen) return null;

  const window = Math.min(text.length, config.window);
  const tail = text.slice(-window);

  const lastChar = tail[tail.length - 1]!;
  if (!isWhitespaceOnly(lastChar)) {
    let run = 1;
    for (let i = tail.length - 2; i >= 0; i -= 1) {
      if (tail[i] !== lastChar) break;
      run += 1;
    }
    if (run > config.charRunThreshold) {
      return `character "${lastChar}" repeated ${run} times in a row`;
    }
  }

  const maxN = Math.min(config.maxNgram, Math.floor(window / 2));
  for (let n = 2; n <= maxN; n += 1) {
    const unit = tail.slice(-n);
    if (isWhitespaceOnly(unit)) continue;
    let repeats = 1;
    let pos = tail.length - 2 * n;
    while (pos >= 0 && tail.slice(pos, pos + n) === unit) {
      repeats += 1;
      pos -= n;
    }
    const covered = repeats * n;
    if (repeats >= config.ngramMinRepeats && covered >= config.ngramRatioThreshold * window) {
      const preview = unit.length > 20 ? `${unit.slice(0, 20)}…` : unit;
      return `sequence "${preview}" (${n} chars) repeated ${repeats} times, covering ${Math.round(
        (covered / window) * 100
      )}% of the tail window`;
    }
  }

  return null;
}

/** Thrown by the stream consumer when {@link detectRepetitionLoop} fires. */
export class RepetitionLoopAbortError extends Error {
  readonly reason: string;
  /** Accumulated stream text that tripped the watchdog, so a trace can show the loop. */
  readonly sample: string;
  constructor(reason: string, sample = '') {
    super(`repetition loop aborted: ${reason}`);
    this.name = 'RepetitionLoopAbortError';
    this.reason = reason;
    this.sample = sample;
  }
}

export function isRepetitionAbort(err: unknown): err is RepetitionLoopAbortError {
  return err instanceof RepetitionLoopAbortError;
}

/**
 * Stateful helper for stream consumers: feed each text delta, throw on hit.
 * Checks are throttled to every `checkEveryChars` appended characters so a
 * chatty stream does not pay the window scan on every token.
 */
export class RepetitionStreamGuard {
  private acc = '';
  private sinceCheck = 0;

  constructor(
    private readonly config: RepetitionWatchdogConfig = loadRepetitionWatchdogConfig(),
    private readonly checkEveryChars = 32
  ) {}

  /** @returns the abort reason on hit (caller decides to throw), else null. */
  push(delta: string): string | null {
    if (!delta) return null;
    this.acc += delta;
    this.sinceCheck += delta.length;
    if (this.sinceCheck < this.checkEveryChars) return null;
    this.sinceCheck = 0;
    return detectRepetitionLoop(this.acc, this.config);
  }

  get text(): string {
    return this.acc;
  }
}

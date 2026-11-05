/**
 * Live read of a generating turn: what the assistant is doing, and how fast
 * visible output is arriving. The chat bubble renders this; it does not touch the stream.
 */

import { formatElapsedMs } from './session-chrome.ts';

export type LivePhase = 'waiting' | 'thinking' | 'writing' | 'tool' | 'card';

export type LiveSegment = {
  kind: string;
  text?: string;
  raw?: string;
  name?: string;
  args?: string;
};

export type LiveSample = { atMs: number; chars: number };

export type StreamLiveSnapshot = {
  phase: LivePhase;
  toolName: string;
  elapsedMs: number;
  chars: number;
  charsPerSec: number | null;
};

type QuietPhase = 'waiting' | 'thinking' | 'writing' | 'card';

export type LiveLabels = {
  phase: Record<QuietPhase, string>;
  tool: (name: string) => string;
  speed: (rate: number) => string;
  speedNone: string;
  chars: (count: number) => string;
};

export type LiveLines = {
  phaseKey: LivePhase;
  phase: string;
  pace: string;
  elapsed: string;
  speed: string;
  chars: string;
  toolName: string;
  showTool: boolean;
  showDots: boolean;
};

const PHASE: Record<string, LivePhase> = {
  tool: 'tool',
  reasoning: 'thinking',
  text: 'writing',
  a2ui: 'card'
};

const SAMPLE_GAP_MS = 400;
const RATE_WINDOW_MS = 2500;
const MIN_RATE_SPAN_S = 0.25;
const SHORT_ELAPSED_MS = 10_000;

export function showLiveDots(visibleCount: number, hiddenCount: number): boolean {
  return visibleCount === 0 && hiddenCount === 0;
}

export function outputChars(segments: readonly LiveSegment[]): number {
  let total = 0;
  for (const seg of segments) total += segmentChars(seg);
  return total;
}

export function latestPhase(segments: readonly LiveSegment[]): { phase: LivePhase; toolName: string } {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const found = phaseAt(segments[i]);
    if (found) return found;
  }
  return { phase: 'waiting', toolName: '' };
}

export function pushSample(samples: readonly LiveSample[], chars: number, nowMs: number): LiveSample[] {
  const last = samples[samples.length - 1];
  if (sameRecentSample(last, chars, nowMs)) return samples as LiveSample[];
  const cutoff = nowMs - 8000;
  const kept = samples.filter((sample) => sample.atMs >= cutoff);
  kept.push({ atMs: nowMs, chars });
  return kept;
}

export function charsPerSecond(samples: readonly LiveSample[], nowMs: number): number | null {
  const span = rateSpan(samples, nowMs);
  if (!span) return null;
  const dt = (span.last.atMs - span.first.atMs) / 1000;
  if (dt < MIN_RATE_SPAN_S) return null;
  const rate = (span.last.chars - span.first.chars) / dt;
  if (!Number.isFinite(rate) || rate < 0) return null;
  return Math.round(rate);
}

export function formatLiveElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  if (ms < SHORT_ELAPSED_MS) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsedMs(ms);
}

export function snapshotLive(input: {
  segments: readonly LiveSegment[];
  startedAtMs: number;
  nowMs: number;
  samples: readonly LiveSample[];
}): StreamLiveSnapshot {
  const activity = latestPhase(input.segments);
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  return {
    phase: activity.phase,
    toolName: activity.toolName,
    elapsedMs,
    chars: outputChars(input.segments),
    charsPerSec: charsPerSecond(input.samples, input.nowMs)
  };
}

export function liveLines(live: StreamLiveSnapshot, dots: boolean, labels: LiveLabels): LiveLines {
  return {
    phaseKey: live.phase,
    phase: phaseLabel(live, labels),
    pace: paceLabel(live, labels),
    elapsed: formatLiveElapsed(live.elapsedMs),
    speed: speedLabel(live, labels),
    chars: labels.chars(live.chars),
    toolName: live.toolName,
    showTool: live.phase === 'tool',
    showDots: dots
  };
}

function segmentChars(seg: LiveSegment): number {
  if (seg.kind === 'text') return seg.raw?.length ?? 0;
  if (seg.kind === 'reasoning') return seg.text?.length ?? 0;
  if (seg.kind === 'tool') return seg.args?.length ?? 0;
  return 0;
}

function phaseAt(seg: LiveSegment): { phase: LivePhase; toolName: string } | null {
  const phase = PHASE[seg.kind];
  if (!phase) return null;
  if (blankWriting(phase, seg) || blankThinking(phase, seg)) return null;
  return namedPhase(phase, seg);
}

function blankWriting(phase: LivePhase, seg: LiveSegment): boolean {
  if (phase !== 'writing') return false;
  return !(seg.raw ?? '').trim();
}

function blankThinking(phase: LivePhase, seg: LiveSegment): boolean {
  if (phase !== 'thinking') return false;
  return !(seg.text ?? '').trim();
}

function namedPhase(phase: LivePhase, seg: LiveSegment): { phase: LivePhase; toolName: string } {
  if (phase !== 'tool') return { phase, toolName: '' };
  const name = seg.name?.trim() || 'unknown';
  return { phase, toolName: name };
}

function sameRecentSample(last: LiveSample | undefined, chars: number, nowMs: number): boolean {
  if (!last) return false;
  if (last.chars !== chars) return false;
  return nowMs - last.atMs < SAMPLE_GAP_MS;
}

function rateSpan(
  samples: readonly LiveSample[],
  nowMs: number
): { first: LiveSample; last: LiveSample } | null {
  const recent = samples.filter((sample) => nowMs - sample.atMs <= RATE_WINDOW_MS);
  const span = recent.length >= 2 ? recent : samples;
  if (span.length < 2) return null;
  return { first: span[0], last: span[span.length - 1] };
}

function phaseLabel(live: StreamLiveSnapshot, labels: LiveLabels): string {
  if (live.phase === 'tool') return labels.tool(live.toolName);
  return labels.phase[live.phase];
}

function paceLabel(live: StreamLiveSnapshot, labels: LiveLabels): string {
  if (live.charsPerSec == null) return formatLiveElapsed(live.elapsedMs);
  return labels.speed(live.charsPerSec);
}

function speedLabel(live: StreamLiveSnapshot, labels: LiveLabels): string {
  if (live.charsPerSec == null) return labels.speedNone;
  return labels.speed(live.charsPerSec);
}

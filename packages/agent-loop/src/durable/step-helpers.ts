/**
 * Pure durable execution decision helpers — zero Node I/O, low CC (<= 5).
 */

import type {
  DurableStepRecord,
  EffectClass,
  KernelCheckpointState,
  ReplayPolicy,
  WaveRollbackPolicy,
} from './types.js';
import type { ToolCallPart, ToolContract } from '../types.js';

/** Portable 64-bit FNV-1a hex digest (no node:crypto needed in mini). */
export function portableHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function canonicalStableString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStableString).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStableString(rec[k])}`).join(',')}}`;
}

export function deriveStepIdempotencyKey(input: {
  sessionId: string;
  runId: string;
  turn: number;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  customKey?: string;
}): string {
  const base = input.customKey
    ? `${input.sessionId}|${input.toolName ?? ''}|${input.customKey}`
    : `${input.sessionId}|${input.runId}|${input.turn}|${input.toolCallId ?? ''}|${canonicalStableString(input.args ?? {})}`;
  return `idem_${portableHash(base)}`;
}

export function resolveToolEffectClass(
  tool: Pick<ToolContract<Record<string, unknown>>, 'effectClass' | 'sideEffectLevel' | 'irreversible'> | undefined
): EffectClass {
  if (!tool) return 'external_irreversible';
  if (tool.effectClass) return tool.effectClass;
  if (tool.sideEffectLevel === 'none') return 'read';
  if (tool.irreversible) return 'external_irreversible';
  return 'external_irreversible';
}

export function resolveToolReplayPolicy(
  tool: Pick<ToolContract<Record<string, unknown>>, 'replay'> | undefined
): ReplayPolicy {
  return tool?.replay === 'safe' ? 'safe' : 'unsafe';
}

/**
 * Double-checked replay safety (inspired by pi-durable):
 * BOTH the recorded intent and the live tool contract must declare `safe`,
 * AND the run must still be below `restartLimit`.
 */
export function canReplayUnknownStep(input: {
  storedReplay: ReplayPolicy;
  currentToolReplay: ReplayPolicy;
  restarts: number;
  restartLimit: number;
}): boolean {
  if (input.storedReplay !== 'safe') return false;
  if (input.currentToolReplay !== 'safe') return false;
  return input.restarts < input.restartLimit;
}

export function createInitialDurableKernelState(): KernelCheckpointState {
  return {
    turn: 0,
    stepCursor: 0,
    advisoryGraceUsed: 0,
    pendingAdvisories: [],
    spinNoProgressStreak: 0,
    cumulativeInputTokens: 0,
    sameToolStreak: 0,
    loopFailureCount: 0,
    riskScore: 0,
  };
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArrayOr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function normalizeDurableKernelState(raw: unknown): KernelCheckpointState {
  const base = createInitialDurableKernelState();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  return {
    turn: numOr(o.turn, base.turn),
    stepCursor: numOr(o.stepCursor, base.stepCursor),
    advisoryGraceUsed: numOr(o.advisoryGraceUsed, base.advisoryGraceUsed),
    pendingAdvisories: stringArrayOr(o.pendingAdvisories),
    spinNoProgressStreak: numOr(o.spinNoProgressStreak, base.spinNoProgressStreak),
    cumulativeInputTokens: numOr(o.cumulativeInputTokens, base.cumulativeInputTokens),
    sameToolStreak: numOr(o.sameToolStreak, base.sameToolStreak),
    loopFailureCount: numOr(o.loopFailureCount, base.loopFailureCount),
    riskScore: numOr(o.riskScore, base.riskScore),
  };
}

export function isStepAlreadyTerminal(step: DurableStepRecord | undefined): boolean {
  return step?.phase === 'committed' || step?.phase === 'failed';
}

export function shouldTriggerWaveCompensation(input: {
  results: readonly { ok: boolean; hold?: string; metadata?: Record<string, unknown> }[];
  aborted: boolean;
  policy?: WaveRollbackPolicy;
  explicitRollback?: boolean;
}): boolean {
  if (input.explicitRollback) return true;
  if (input.aborted) return true;
  if (input.policy === 'abort_or_tx_only') return false;
  return input.results.some((r) => !r.ok && r.hold !== 'approval' && r.metadata?.cancelledBySteer !== true);
}

/**
 * Partition tool calls into ordered sub-waves so read/local/compensatable
 * operations settle before any `external_irreversible` pivot call executes.
 */
export function partitionCallsByEffectStage(
  calls: readonly ToolCallPart[],
  tools: readonly ToolContract<Record<string, unknown>>[]
): { prePivot: ToolCallPart[]; pivot: ToolCallPart[] } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const prePivot: ToolCallPart[] = [];
  const pivot: ToolCallPart[] = [];
  for (const call of calls) {
    const cls = resolveToolEffectClass(byName.get(call.name));
    if (cls === 'external_irreversible') pivot.push(call);
    else prePivot.push(call);
  }
  return { prePivot, pivot };
}

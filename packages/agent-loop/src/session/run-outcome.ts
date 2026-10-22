/**
 * Single terminal RunOutcome for an L4 loop (A8).
 *
 * Session.status remains the L5/HTTP projection for a quarter; hosts should
 * read `outcome` from the ended event or session.metadata.outcome.
 */

export type RunOutcomeKind = 'completed' | 'idle' | 'waiting_approval' | 'failed' | 'aborted';

export type FailureStage = 'model' | 'tool' | 'approval' | 'recovery' | 'host' | 'rewind';

export interface RunOutcomeRewind {
  toSeq: number;
  shadowedCount: number;
  reason: string;
}

export interface RunOutcome {
  kind: RunOutcomeKind;
  reason: string;
  failureStage?: FailureStage;
  rewind?: RunOutcomeRewind;
}

export const RUN_OUTCOME_METADATA_KEY = 'outcome';

export function buildRunOutcome(input: {
  kind: RunOutcomeKind;
  reason: string;
  failureStage?: FailureStage;
  rewind?: RunOutcomeRewind;
}): RunOutcome {
  const outcome: RunOutcome = { kind: input.kind, reason: input.reason };
  if (input.failureStage) outcome.failureStage = input.failureStage;
  if (input.rewind) outcome.rewind = input.rewind;
  return outcome;
}

/** Map an L4 end reason + resulting session status onto a single outcome. */
export function runOutcomeFromEnd(input: {
  reason: string;
  sessionStatus: string;
  failureStage?: FailureStage;
  rewind?: RunOutcomeRewind;
}): RunOutcome {
  const reason = input.reason;
  const rewind = input.rewind;
  if (reason === 'abort' || reason === 'closed' || reason === 'user_abort') {
    return buildRunOutcome({
      kind: 'aborted',
      reason,
      failureStage: input.failureStage ?? 'host',
      rewind
    });
  }
  if (reason === 'waiting_approval') {
    return buildRunOutcome({
      kind: 'waiting_approval',
      reason,
      failureStage: input.failureStage ?? 'approval',
      rewind
    });
  }
  if (
    reason === 'empty_assistant' ||
    reason === 'empty_tool_calls' ||
    reason === 'leaked_tool_call' ||
    reason === 'truncated_tool_call' ||
    reason === 'content_filter' ||
    reason === 'repetition' ||
    reason === 'reasoning_spin' ||
    reason === 'loop_guard_critical'
  ) {
    return buildRunOutcome({
      kind: input.sessionStatus === 'failed' ? 'failed' : 'idle',
      reason,
      failureStage: input.failureStage ?? 'recovery',
      rewind
    });
  }
  if (reason === 'tool_loop' || reason === 'repeat_detection' || reason === 'missing_assistant') {
    return buildRunOutcome({
      kind: input.sessionStatus === 'failed' ? 'failed' : 'idle',
      reason,
      failureStage: input.failureStage ?? (reason === 'missing_assistant' ? 'model' : 'tool'),
      rewind
    });
  }
  if (reason === 'before_turn_blocked') {
    return buildRunOutcome({
      kind: 'failed',
      reason,
      failureStage: input.failureStage ?? 'host',
      rewind
    });
  }
  if (reason === 'rewound') {
    return buildRunOutcome({
      kind: 'failed',
      reason,
      failureStage: input.failureStage ?? 'rewind',
      rewind
    });
  }
  if (input.sessionStatus === 'failed') {
    return buildRunOutcome({
      kind: 'failed',
      reason,
      failureStage: input.failureStage ?? 'model',
      rewind
    });
  }
  if (input.sessionStatus === 'completed') {
    return buildRunOutcome({ kind: 'completed', reason, rewind });
  }
  if (input.sessionStatus === 'waiting_approval') {
    return buildRunOutcome({
      kind: 'waiting_approval',
      reason,
      failureStage: input.failureStage ?? 'approval',
      rewind
    });
  }
  return buildRunOutcome({ kind: 'idle', reason, rewind });
}

export function parseRunOutcome(raw: unknown): RunOutcome | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (
    kind !== 'completed' &&
    kind !== 'idle' &&
    kind !== 'waiting_approval' &&
    kind !== 'failed' &&
    kind !== 'aborted'
  ) {
    return undefined;
  }
  const reason = typeof obj.reason === 'string' ? obj.reason : 'unknown';
  const failureStage = parseFailureStage(obj.failureStage);
  const rewind = parseRewind(obj.rewind);
  return buildRunOutcome({ kind, reason, failureStage, rewind });
}

function parseFailureStage(raw: unknown): FailureStage | undefined {
  if (
    raw === 'model' ||
    raw === 'tool' ||
    raw === 'approval' ||
    raw === 'recovery' ||
    raw === 'host' ||
    raw === 'rewind'
  ) {
    return raw;
  }
  return undefined;
}

function parseRewind(raw: unknown): RunOutcomeRewind | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.toSeq !== 'number' || typeof o.shadowedCount !== 'number') return undefined;
  return {
    toSeq: o.toSeq,
    shadowedCount: o.shadowedCount,
    reason: typeof o.reason === 'string' ? o.reason : 'rewind'
  };
}

export function mergeOutcomeMetadata(
  metadata: Record<string, unknown>,
  outcome: RunOutcome
): Record<string, unknown> {
  return { ...metadata, [RUN_OUTCOME_METADATA_KEY]: outcome };
}

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
  /**
   * Only with reason `max_turns`: the run was cut by the turn limit, but the
   * forced last turn still produced a final text answer.
   */
  answered?: boolean;
}

/** Reason recorded when the turn limit, not the model, ended the run. */
export const TURN_LIMIT_REASON = 'max_turns';

/**
 * True when the run stopped with a final answer: a normal `end`, or a
 * turn-limit stop whose forced last turn answered. Use this where a consumer
 * needs "there is a reply to deliver", not "the work is finished".
 */
export function endedWithAnswer(outcome: Pick<RunOutcome, 'reason' | 'answered'> | undefined): boolean {
  if (!outcome) return false;
  return outcome.reason === 'end' || (outcome.reason === TURN_LIMIT_REASON && outcome.answered === true);
}

export const RUN_OUTCOME_METADATA_KEY = 'outcome';

export function buildRunOutcome(input: {
  kind: RunOutcomeKind;
  reason: string;
  failureStage?: FailureStage;
  rewind?: RunOutcomeRewind;
  answered?: boolean;
}): RunOutcome {
  const outcome: RunOutcome = { kind: input.kind, reason: input.reason };
  if (input.failureStage) outcome.failureStage = input.failureStage;
  if (input.rewind) outcome.rewind = input.rewind;
  if (input.answered === true && input.reason === TURN_LIMIT_REASON) outcome.answered = true;
  return outcome;
}

interface RunEndInput {
  reason: string;
  sessionStatus: string;
  failureStage?: FailureStage;
  rewind?: RunOutcomeRewind;
  /** Turn-limit stop whose forced last turn still answered. */
  answered?: boolean;
}

const ABORT_REASONS = new Set(['abort', 'closed', 'user_abort']);
const RECOVERY_REASONS = new Set([
  'empty_assistant',
  'empty_tool_calls',
  'leaked_tool_call',
  'truncated_tool_call',
  'content_filter',
  'repetition',
  'reasoning_spin',
  'loop_guard_critical',
]);
const TOOL_REASONS = new Set(['tool_loop', 'repeat_detection', 'missing_assistant']);
/** Reasons that always mean a failed run, with the stage they point at. */
const FAILED_REASON_STAGE = new Map<string, FailureStage>([['before_turn_blocked', 'host'], ['rewound', 'rewind']]);

/** Outcome decided by the end reason alone; undefined when the session status decides. */
function outcomeFromReason(input: RunEndInput): RunOutcome | undefined {
  const { reason, rewind } = input;
  if (ABORT_REASONS.has(reason)) {
    return buildRunOutcome({ kind: 'aborted', reason, failureStage: input.failureStage ?? 'host', rewind });
  }
  if (reason === 'waiting_approval') {
    return buildRunOutcome({ kind: 'waiting_approval', reason, failureStage: input.failureStage ?? 'approval', rewind });
  }
  const stopped = input.sessionStatus === 'failed' ? 'failed' : 'idle';
  if (RECOVERY_REASONS.has(reason)) {
    return buildRunOutcome({ kind: stopped, reason, failureStage: input.failureStage ?? 'recovery', rewind });
  }
  if (TOOL_REASONS.has(reason)) {
    const stage = reason === 'missing_assistant' ? 'model' : 'tool';
    return buildRunOutcome({ kind: stopped, reason, failureStage: input.failureStage ?? stage, rewind });
  }
  const failedStage = FAILED_REASON_STAGE.get(reason);
  if (failedStage) {
    return buildRunOutcome({ kind: 'failed', reason, failureStage: input.failureStage ?? failedStage, rewind });
  }
  return undefined;
}

/** Map an L4 end reason + resulting session status onto a single outcome. */
export function runOutcomeFromEnd(input: RunEndInput): RunOutcome {
  const decided = outcomeFromReason(input);
  if (decided) return decided;
  const { reason, rewind, answered } = input;
  if (input.sessionStatus === 'failed') {
    return buildRunOutcome({ kind: 'failed', reason, failureStage: input.failureStage ?? 'model', rewind });
  }
  if (input.sessionStatus === 'completed') {
    return buildRunOutcome({ kind: 'completed', reason, rewind, answered });
  }
  if (input.sessionStatus === 'waiting_approval') {
    return buildRunOutcome({ kind: 'waiting_approval', reason, failureStage: input.failureStage ?? 'approval', rewind });
  }
  return buildRunOutcome({ kind: 'idle', reason, rewind, answered });
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
  return buildRunOutcome({ kind, reason, failureStage, rewind, answered: obj.answered === true });
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

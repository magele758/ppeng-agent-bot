/**
 * Serializable run interruption (A6).
 *
 * `waiting_approval` is a latch terminal, but the next `createAgentLoop(id).step()`
 * (or `runSession`) must resume from the tools checkpoint after approve —
 * not silently re-enter the model from scratch.
 *
 * Stored on `session.metadata.interrupt` (no extra table; stay under 4k).
 */

import type { MessagePart, SessionRecord } from '../types.js';
import { unmatchedToolCallIds } from './surface-invariants.js';

export const INTERRUPT_METADATA_KEY = 'interrupt';

export interface RunInterruptState {
  kind: 'waiting_approval';
  toolCallIds: string[];
  approvalIds: string[];
  writerRunId?: string;
  executedToolCallIds: string[];
  stepCursor: 'tools';
}

export type InterruptResumeAction =
  | { action: 'yield_waiting'; interrupt: RunInterruptState }
  | { action: 'resume_tools'; interrupt: RunInterruptState }
  | { action: 'none' };

type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>;

export function createWaitingApprovalInterrupt(input: {
  toolCallIds: string[];
  approvalIds: string[];
  writerRunId?: string;
  executedToolCallIds?: string[];
}): RunInterruptState {
  return {
    kind: 'waiting_approval',
    toolCallIds: [...input.toolCallIds],
    approvalIds: [...input.approvalIds],
    writerRunId: input.writerRunId,
    executedToolCallIds: [...(input.executedToolCallIds ?? [])],
    stepCursor: 'tools'
  };
}

export function parseRunInterrupt(metadata: Record<string, unknown> | undefined): RunInterruptState | undefined {
  const raw = metadata?.[INTERRUPT_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'waiting_approval') return undefined;
  const toolCallIds = asStringArray(obj.toolCallIds);
  const approvalIds = asStringArray(obj.approvalIds);
  const executedToolCallIds = asStringArray(obj.executedToolCallIds);
  const writerRunId = typeof obj.writerRunId === 'string' && obj.writerRunId ? obj.writerRunId : undefined;
  return {
    kind: 'waiting_approval',
    toolCallIds,
    approvalIds,
    writerRunId,
    executedToolCallIds,
    stepCursor: 'tools'
  };
}

export function mergeInterruptMetadata(
  metadata: Record<string, unknown>,
  interrupt: RunInterruptState | null
): Record<string, unknown> {
  const next = { ...metadata };
  if (interrupt) next[INTERRUPT_METADATA_KEY] = interrupt;
  else delete next[INTERRUPT_METADATA_KEY];
  return next;
}

export function decideInterruptResume(input: {
  session: SessionRecord;
  pendingApprovalIds: string[];
}): InterruptResumeAction {
  const interrupt = parseRunInterrupt(input.session.metadata);
  const pending = new Set(input.pendingApprovalIds);

  if (interrupt) {
    const tracked = interrupt.approvalIds.length > 0;
    const stillPending = tracked
      ? interrupt.approvalIds.some((id) => pending.has(id))
      : input.session.status === 'waiting_approval';
    if (stillPending) return { action: 'yield_waiting', interrupt };
    return { action: 'resume_tools', interrupt };
  }

  if (input.session.status === 'waiting_approval') {
    return {
      action: 'yield_waiting',
      interrupt: createWaitingApprovalInterrupt({ toolCallIds: [], approvalIds: [...pending] })
    };
  }
  return { action: 'none' };
}

/**
 * Calls the approval gate already closed are skipped in memory.
 * A host that did not report keeps the current wave, filtered by still-unmatched ids.
 * Reused ids (heuristic_read_dir) must not replay an earlier call that already has a result.
 */
export interface ToolCallClosure {
  reported: boolean;
  ids: readonly string[];
}

export function selectExecutableToolCalls<T extends { toolCallId: string }>(
  calls: readonly T[],
  closure: ToolCallClosure | undefined,
  foldUnmatched: () => readonly T[]
): T[] {
  if (!closure?.reported) {
    const open = new Set(foldUnmatched().map((call) => call.toolCallId));
    return calls.filter((call) => open.has(call.toolCallId));
  }
  if (closure.ids.length === 0) return [...calls];
  const closed = new Set(closure.ids);
  return calls.filter((call) => !closed.has(call.toolCallId));
}

/**
 * Latest unmatched tool_call per id. An id that was closed and then reused
 * contributes only the call that reopened it.
 */
export function unmatchedToolCallsFromFold(
  folded: Array<{ parts: MessagePart[] }>,
  allowIds?: string[]
): ToolCallPart[] {
  const open = new Set(unmatchedToolCallIds(folded));
  const allow = allowIds ? new Set(allowIds) : open;
  const latest = new Map<string, ToolCallPart>();
  for (const message of folded) {
    for (const part of message.parts) {
      if (part.type === 'tool_call' && open.has(part.toolCallId) && allow.has(part.toolCallId)) {
        latest.set(part.toolCallId, part);
      }
    }
  }
  return [...latest.values()];
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v)).filter(Boolean);
}

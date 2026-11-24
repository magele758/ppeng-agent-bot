/**
 * Single-tool Intent-First & Replay Memoization hooks for tool-loop.ts.
 * Zero Node I/O (mini-safe), every helper kept at CC <= 5.
 */

import type { RunContext, ToolCallPart, ToolContract } from '../types.js';
import {
  canReplayUnknownStep,
  canonicalStableString,
  deriveStepIdempotencyKey,
  portableHash,
  resolveToolEffectClass,
  resolveToolReplayPolicy,
} from './step-helpers.js';
import type {
  DurableJournalPort,
  DurableStepRecord,
  ToolParkDirective,
} from './types.js';

export interface DurableToolLoopContext {
  journal: DurableJournalPort;
  runId: string;
  sessionId: string;
  turn: number;
  waveIndex: number;
  fencingEpoch?: number;
  restartLimit: number;
  /** Resolve cached result for an already-committed toolCallId (from session WAL). */
  getCommittedToolResult?: (toolCallId: string) => { ok: boolean; content: string; name: string } | undefined;
  /** Immediately persist a single settled tool result atomically with step commit. */
  persistSingleToolResult?: (
    result: {
      toolCallId: string;
      name: string;
      ok: boolean;
      content: string;
      isExternal?: boolean;
      images?: unknown[];
      media?: unknown[];
      metadata?: Record<string, unknown>;
      problem?: unknown;
      ran?: boolean;
      durationMs?: number;
      hold?: 'approval';
    },
    call: ToolCallPart
  ) => number | undefined;
  /** Lazy savepoint hook invoked before first mutating tool in the wave (Phase 2). */
  ensureWaveSavepoint?: (tool: ToolContract<Record<string, unknown>>, call: ToolCallPart) => Promise<string | undefined>;
  /** Optional post-wave hook to record post-mutation workspace state for CAS conflict detection. */
  onWaveSettled?: () => Promise<void> | void;
}

export type PreDispatchDecision =
  | { action: 'execute'; step: DurableStepRecord; memo: <T>(key: string, compute: () => T | Promise<T>) => Promise<T> }
  | { action: 'replay_cached'; result: { toolCallId: string; name: string; ok: boolean; content: string; ran: false } }
  | { action: 'interrupted_unsafe'; result: { toolCallId: string; name: string; ok: false; content: string; ran: false } };

export const INTERRUPTED_UNSAFE_RESULT =
  '[interrupted] Tool execution was interrupted by a process restart and is not marked replay-safe. Side effects are unconfirmed; inspect current state before retrying.';

export function planDurableToolWave(
  ctx: DurableToolLoopContext,
  calls: readonly ToolCallPart[],
  tools: readonly ToolContract<Record<string, unknown>>[]
): DurableStepRecord[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const planned: DurableStepRecord[] = [];
  for (const call of calls) {
    const tool = byName.get(call.name);
    const customKey = tool?.idempotencyKey?.(call.input as Record<string, unknown>);
    const step = ctx.journal.planStep({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      turn: ctx.turn,
      waveIndex: ctx.waveIndex,
      fencingEpoch: ctx.fencingEpoch ?? 1,
      kind: 'tool_call',
      toolCallId: call.toolCallId,
      toolName: call.name,
      idempotencyKey: deriveStepIdempotencyKey({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        turn: ctx.turn,
        toolCallId: call.toolCallId,
        toolName: call.name,
        args: call.input,
        customKey,
      }),
      effectClass: resolveToolEffectClass(tool),
      replayPolicy: resolveToolReplayPolicy(tool),
      argsHash: portableHash(canonicalStableString(call.input ?? {})),
    });
    planned.push(step);
  }
  return planned;
}

function createStepMemo(journal: DurableJournalPort, stepId: string) {
  return async <T>(key: string, compute: () => T | Promise<T>): Promise<T> => {
    const existing = journal.getMemo<T>(stepId, key);
    if (existing !== undefined) return existing;
    const computed = await compute();
    return journal.memo(stepId, key, computed);
  };
}

function buildCachedResult(
  ctx: DurableToolLoopContext,
  call: ToolCallPart,
  step: DurableStepRecord
): PreDispatchDecision {
  const cached = ctx.getCommittedToolResult?.(call.toolCallId);
  if (cached) {
    return {
      action: 'replay_cached',
      result: { toolCallId: call.toolCallId, name: cached.name, ok: cached.ok, content: cached.content, ran: false },
    };
  }
  return {
    action: 'replay_cached',
    result: {
      toolCallId: call.toolCallId,
      name: call.name,
      ok: step.phase === 'committed',
      content: step.errorText ?? '[durable-replay] step already committed',
      ran: false,
    },
  };
}

export async function prepareDurableToolDispatch(
  ctx: DurableToolLoopContext,
  tool: ToolContract<Record<string, unknown>>,
  call: ToolCallPart
): Promise<PreDispatchDecision> {
  const existing = ctx.journal.getStepByToolCall(ctx.runId, call.toolCallId, ctx.turn)
    ?? planDurableToolWave(ctx, [call], [tool])[0]!;

  const currentEpoch = ctx.fencingEpoch ?? 1;
  const stepEpoch = existing.fencingEpoch ?? 1;
  if ((existing.phase === 'committed' || existing.phase === 'failed') && stepEpoch < currentEpoch) {
    return buildCachedResult(ctx, call, existing);
  }

  if (existing.phase === 'unknown') {
    const run = ctx.journal.getRun(ctx.runId);
    const allowed = canReplayUnknownStep({
      storedReplay: existing.replayPolicy,
      currentToolReplay: resolveToolReplayPolicy(tool),
      restarts: run?.restarts ?? 0,
      restartLimit: ctx.restartLimit,
    });
    if (!allowed) {
      ctx.journal.failStep(existing.stepId, INTERRUPTED_UNSAFE_RESULT);
      return {
        action: 'interrupted_unsafe',
        result: {
          toolCallId: call.toolCallId,
          name: call.name,
          ok: false,
          content: INTERRUPTED_UNSAFE_RESULT,
          ran: false,
        },
      };
    }
  }

  const snapshotRef = await ctx.ensureWaveSavepoint?.(tool, call);
  const dispatched = ctx.journal.markStepDispatched(existing.stepId, { snapshotRef });
  if (dispatched.effectClass === 'external_irreversible') {
    ctx.journal.updateRun(ctx.runId, { passedPivot: true });
  }
  return { action: 'execute', step: dispatched, memo: createStepMemo(ctx.journal, dispatched.stepId) };
}

export function attachDurableMemoContext(
  context: RunContext,
  stepId: string,
  memo: <T>(key: string, compute: () => T | Promise<T>) => Promise<T>
): RunContext {
  return { ...context, durableStepId: stepId, memo };
}

export function settleDurableToolResult(
  ctx: DurableToolLoopContext,
  tool: ToolContract<Record<string, unknown>>,
  call: ToolCallPart,
  step: DurableStepRecord,
  context: RunContext,
  args: Record<string, unknown>,
  result: {
    toolCallId: string;
    name: string;
    ok: boolean;
    content: string;
    hold?: 'approval';
    park?: ToolParkDirective;
    metadata?: Record<string, unknown>;
  }
): void {
  if (result.hold === 'approval') return;
  if (result.park) {
    ctx.journal.parkStep(step.stepId, result.park);
    ctx.journal.updateRun(ctx.runId, { status: 'waiting_park', restarts: 0 });
    return;
  }
  const compSpec = result.ok
    ? tool.buildCompensation?.(context, args, { ok: result.ok, content: result.content, metadata: result.metadata }, step.snapshotRef) ?? undefined
    : undefined;
  const persist = () => {
    const seq = ctx.persistSingleToolResult?.(result, call);
    if (result.ok) {
      ctx.journal.commitStep(step.stepId, {
        messageSeq: seq,
        receipt: extractReceipt(result.metadata),
        compensationSpec: compSpec,
      });
    } else {
      ctx.journal.failStep(step.stepId, result.content.slice(0, 500), { messageSeq: seq });
    }
    ctx.journal.updateRun(ctx.runId, { restarts: 0 });
  };
  if (ctx.journal.withTransaction) ctx.journal.withTransaction(persist);
  else persist();
}

function extractReceipt(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (metadata.receipt && typeof metadata.receipt === 'object') {
    return metadata.receipt as Record<string, unknown>;
  }
  return undefined;
}

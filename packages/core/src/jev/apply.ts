/**
 * Optional chain steps. Each one no-ops unless that insertion point is active.
 */

import type { MessagePart, SessionMessage } from '../types.js';
import { stableJsonHash } from '../runtime/helpers.js';
import { askJev, choiceOf, noulOf } from './client.js';
import { applyJevContextSelect as applyJevContextSelectPoint } from './points/context-select.js';
import { applyJevMemorySelect as applyJevMemorySelectPoint } from './points/memory-select.js';
import { applyJevPreTurn as applyJevPreTurnPoint } from './points/pre-turn.js';
import { applyJevRecoveryChoice as applyJevRecoveryChoicePoint } from './points/recovery-choice.js';
import { applyJevSagaGate as applyJevSagaGatePoint } from './points/saga-gate.js';
import { applyJevSkillSelect as applyJevSkillSelectPoint } from './points/skill-select.js';
import { applyJevToolSelect as applyJevToolSelectPoint } from './points/tool-select.js';
import { chainHas, resolveJevChain, type JevSettingsStore } from './settings.js';

const RISKY_TOOLS = new Set(['bash', 'claude_code', 'codex_exec', 'cursor_agent']);
const GOAL_MET_AT = 0.8;
const TOOL_ACT_AT = 0.7;
const COMPACT_DROP_BELOW = 0.2;
/** Route fan-out: only high-confidence answers may change control flow. */
const ROUTE_ACT_AT = 0.75;

type ToolCall = { toolCallId: string; name: string; input: Record<string, unknown> };

export interface JevSettledApproval {
  sessionId: string;
  status: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface JevToolStore extends JevSettingsStore {
  appendMessage(sessionId: string, role: 'tool', parts: MessagePart[]): unknown;
  createApproval(input: {
    sessionId: string;
    toolName: string;
    reason: string;
    args: Record<string, unknown>;
  }): unknown;
  getApproval?(id: string): JevSettledApproval | undefined;
}

export interface JevToolGateOptions {
  /** Approvals already decided for this resumed wave. */
  settledApprovalIds?: readonly string[];
  /** Calls the normal gate already closed, so a rejected review does not write a second result. */
  alreadyClosedIds?: readonly string[];
  markClosed?(ids: string[]): void;
}

export type SettledToolGateDecision = 'create' | 'proceed' | 'waiting' | 'reject';

/** Resume path: an ask for a call that already has a decision must not open another approval. */
export function settledToolGateDecision(
  call: ToolCall,
  sessionId: string,
  settled: readonly JevSettledApproval[]
): SettledToolGateDecision {
  const wanted = stableJsonHash(call.name, call.input);
  const match = settled.find(
    (row) =>
      row.sessionId === sessionId &&
      row.toolName === call.name &&
      stableJsonHash(row.toolName, row.args) === wanted
  );
  if (!match) return 'create';
  if (match.status === 'approved') return 'proceed';
  if (match.status === 'rejected') return 'reject';
  if (match.status === 'pending') return 'waiting';
  return 'create';
}

export function selectGoalJudge(
  store: JevSettingsStore,
  fallback: (input: { system: string; user: string; signal?: AbortSignal }) => Promise<string>
): (input: { system: string; user: string; signal?: AbortSignal }) => Promise<string> {
  return async (input) => {
    const chain = resolveJevChain(store);
    if (!chainHas(chain, 'goalGate')) return fallback(input);
    const answers = await askJev({
      chain: chain!,
      point: 'goalGate',
      state: input.user,
      nouls: [{ id: 'met', instructions: 'Has the goal condition already been met?' }],
      signal: input.signal
    });
    const p = noulOf(answers, 'met');
    if (p == null) return fallback(input);
    return JSON.stringify({
      met: p >= GOAL_MET_AT,
      reason: `jev noul ${p.toFixed(2)}`
    });
  };
}

function rejectSettledReview(
  store: JevToolStore,
  sessionId: string,
  call: ToolCall,
  options: JevToolGateOptions | undefined
): 'proceed' {
  const closed = new Set(options?.alreadyClosedIds ?? []);
  if (!closed.has(call.toolCallId)) {
    store.appendMessage(sessionId, 'tool', [
      {
        type: 'tool_result',
        toolCallId: call.toolCallId,
        name: call.name,
        ok: false,
        content: `Review of ${call.name} was already rejected.`
      }
    ]);
    options?.markClosed?.([call.toolCallId]);
  }
  return 'proceed';
}

export async function applyJevToolGate(
  store: JevToolStore,
  sessionId: string,
  calls: ToolCall[],
  options?: JevToolGateOptions
): Promise<'proceed' | 'skip' | 'waiting'> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'toolGate')) return 'proceed';
  const risky = calls.filter((call) => RISKY_TOOLS.has(call.name));
  if (risky.length === 0) return 'proceed';
  const answers = await askJev({
    chain: chain!,
    point: 'toolGate',
    state: risky
      .map((call) => `${call.name}: ${JSON.stringify(call.input).slice(0, 800)}`)
      .join('\n'),
    choices: [
      {
        id: 'gate',
        instructions: 'Should these tool calls run?',
        options: ['allow', 'ask', 'deny']
      }
    ]
  });
  const picked = choiceOf(answers, 'gate');
  if (!picked || picked.confidence < TOOL_ACT_AT) return 'proceed';
  if (picked.choice === 'deny') {
    store.appendMessage(
      sessionId,
      'tool',
      calls.map((call) => ({
        type: 'tool_result' as const,
        toolCallId: call.toolCallId,
        name: call.name,
        ok: false,
        content: RISKY_TOOLS.has(call.name)
          ? `Blocked by Jev tool gate (deny, confidence ${picked.confidence.toFixed(2)}).`
          : 'Skipped because a sibling call was blocked by the Jev tool gate.'
      }))
    );
    return 'skip';
  }
  if (picked.choice === 'ask') {
    const call = risky[0]!;
    const settled = (options?.settledApprovalIds ?? [])
      .map((id) => store.getApproval?.(id))
      .filter((row): row is JevSettledApproval => row != null);
    const decision = settledToolGateDecision(call, sessionId, settled);
    switch (decision) {
      case 'proceed':
        return 'proceed';
      case 'waiting':
        return 'waiting';
      case 'reject':
        return rejectSettledReview(store, sessionId, call, options);
      case 'create':
        store.createApproval({
          sessionId,
          toolName: call.name,
          reason: `Jev asked for review before ${call.name}`,
          args: call.input
        });
        return 'waiting';
      default: {
        const unreachable: never = decision;
        return unreachable;
      }
    }
  }
  return 'proceed';
}

export async function applyJevCompactView(
  store: JevSettingsStore,
  messages: SessionMessage[]
): Promise<SessionMessage[]> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'compact')) return messages;
  const targets: Array<{ messageIndex: number; partIndex: number; content: string }> = [];
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((part: MessagePart, partIndex: number) => {
      if (part.type !== 'tool_result' || !part.ok || part.content.length < 1_500) return;
      if (targets.length >= 4) return;
      targets.push({ messageIndex, partIndex, content: part.content });
    });
  });
  if (targets.length === 0) return messages;
  const answers = await askJev({
    chain: chain!,
    point: 'compact',
    state: targets.map((target, i) => `[#${i}]\n${target.content.slice(0, 1_200)}`).join('\n\n'),
    nouls: targets.map((_, i) => ({
      id: `k${i}`,
      instructions: 'Is this tool output still needed for the current task?'
    }))
  });
  if (!answers) return messages;
  const drop = new Set<number>();
  targets.forEach((_, i) => {
    const p = noulOf(answers, `k${i}`);
    if (p != null && p < COMPACT_DROP_BELOW) drop.add(i);
  });
  if (drop.size === 0) return messages;
  return messages.map((message, messageIndex) => ({
    ...message,
    parts: message.parts.map((part: MessagePart, partIndex: number) => {
      const hit = targets.findIndex(
        (target) => target.messageIndex === messageIndex && target.partIndex === partIndex
      );
      if (hit < 0 || !drop.has(hit) || part.type !== 'tool_result') return part;
      return {
        ...part,
        content: `${part.content.slice(0, 400)}\n[jev-compact] truncated`
      };
    })
  }));
}

/**
 * Turn-boundary fan-out (soft-stop path: model ended without tool calls).
 *
 * Parallel questions: still need tools? already done? need retry?
 * Low confidence ⇒ noop (keep deep-model path).
 *
 * `done` vs `goalGate`: when `goalGate` is also active, a high-confidence
 * `done` is intentionally ignored here so goalGate (Jev or completeText)
 * remains the sole completion judge. Route `done` only short-circuits the
 * deep-model completion round when `goalGate` is off.
 */
export type JevRouteDecision =
  | { kind: 'noop' }
  | { kind: 'continue'; reason: string }
  | { kind: 'done'; reason: string };

export async function applyJevRoute(
  store: JevSettingsStore,
  input: { state: string; signal?: AbortSignal }
): Promise<JevRouteDecision> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'route')) return { kind: 'noop' };

  const answers = await askJev({
    chain: chain!,
    point: 'route',
    state: input.state.slice(0, 12_000),
    nouls: [
      {
        id: 'need_tools',
        instructions: 'Does the agent still need to call tools to finish the task?'
      },
      {
        id: 'done',
        instructions: 'Has the task already been completed sufficiently to stop?'
      },
      {
        id: 'retry',
        instructions: 'Should the agent retry or revise the last step before stopping?'
      }
    ],
    signal: input.signal
  });
  if (!answers) return { kind: 'noop' };

  const needTools = noulOf(answers, 'need_tools');
  const done = noulOf(answers, 'done');
  const retry = noulOf(answers, 'retry');

  // Prefer continue signals first — never short-circuit stop on weak done.
  if (retry != null && retry >= ROUTE_ACT_AT) {
    return { kind: 'continue', reason: `jev-route retry noul ${retry.toFixed(2)}` };
  }
  if (needTools != null && needTools >= ROUTE_ACT_AT) {
    return { kind: 'continue', reason: `jev-route need_tools noul ${needTools.toFixed(2)}` };
  }

  // done only honored by callers when goalGate is inactive (see comment above).
  if (done != null && done >= ROUTE_ACT_AT) {
    if (chainHas(chain, 'goalGate')) {
      return { kind: 'noop' };
    }
    return { kind: 'done', reason: `jev-route done noul ${done.toFixed(2)}` };
  }

  return { kind: 'noop' };
}

/** contextSelect before compact. null ⇒ caller keeps original messages. */
export async function applyJevContextSelect(
  store: JevSettingsStore,
  messages: SessionMessage[],
  taskText: string
): Promise<SessionMessage[] | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'contextSelect')) return null;
  return applyJevContextSelectPoint(chain, messages, taskText);
}

/**
 * toolSelect after policy allowlist. Returns name subset ∩ allowed, or null
 * to keep the full allowed set.
 */
export async function applyJevToolSelect(
  store: JevSettingsStore,
  taskText: string,
  tools: ReadonlyArray<{ name: string; description?: string }>
): Promise<string[] | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'toolSelect')) return null;
  return applyJevToolSelectPoint(chain!, taskText, tools);
}

/** skillSelect on an existing shortlist. Empty / &lt;2 candidates ⇒ null. */
export async function applyJevSkillSelect(
  store: JevSettingsStore,
  taskText: string,
  skills: ReadonlyArray<{ name: string; description?: string }>
): Promise<string[] | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'skillSelect')) return null;
  if (skills.length === 0) return null;
  return applyJevSkillSelectPoint(chain!, taskText, skills);
}

/** memorySelect on appendix slot candidates. null ⇒ keep all. */
export async function applyJevMemorySelect(
  store: JevSettingsStore,
  taskText: string,
  items: readonly { id: string; text: string }[]
): Promise<string[] | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'memorySelect')) return null;
  return applyJevMemorySelectPoint(chain!, taskText, items);
}

/**
 * recoveryChoice among discrete options the caller already has.
 * Invalid / unknown id ⇒ null (caller keeps hardcoded path).
 */
export async function applyJevRecoveryChoice(
  store: JevSettingsStore,
  situation: string,
  options: readonly { id: string; label: string }[]
): Promise<string | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'recoveryChoice')) return null;
  if (options.length < 2) return null;
  const allowed = new Set(options.map((o) => o.id));
  const picked = await applyJevRecoveryChoicePoint(chain!, situation, options);
  if (!picked || !allowed.has(picked)) return null;
  return picked;
}

/**
 * preTurn before the deep model. goalGate active ⇒ never skip_done.
 * No goal ⇒ ignore skip_done (point module already returns call_model).
 */
export async function applyJevPreTurn(
  store: JevSettingsStore,
  taskText: string,
  hasGoal: boolean
): Promise<'call_model' | 'skip_done' | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'preTurn')) return null;
  const decision = await applyJevPreTurnPoint(chain!, taskText, hasGoal);
  if (decision === 'skip_done' && chainHas(chain, 'goalGate')) return 'call_model';
  if (decision === 'skip_done' && !hasGoal) return 'call_model';
  return decision;
}

/**
 * sagaGate only when the product step already has ≥2 discrete options.
 * Callers with free-text plans must not invoke this.
 */
export async function applyJevSagaGate(
  store: JevSettingsStore,
  taskText: string,
  options: readonly { id: string; label: string }[]
): Promise<{ invokeLlm: boolean; optionId?: string } | null> {
  const chain = resolveJevChain(store);
  if (!chainHas(chain, 'sagaGate')) return null;
  if (options.length < 2) return null;
  return applyJevSagaGatePoint(chain!, taskText, options);
}

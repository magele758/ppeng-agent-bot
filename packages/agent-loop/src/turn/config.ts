/**
 * Loop knobs passed into the kernel. Products populate this from UI / KV.
 * The kernel does not read process.env for these.
 */

import { MAX_VISIBLE_MESSAGES } from '../session/fold-budget.js';

export interface LoopConfig {
  maxTurns?: number;
  maxContextTokens?: number;
  /** Call host.autoCompact at the start of every turn. Default true. */
  compactEveryTurn?: boolean;
  /**
   * Fit the fold when the host does not supply applyFoldBudget. Default true.
   * Under the token budget this does not tail-slice to maxVisibleMessages.
   */
  foldBudgetClamp?: boolean;
  /**
   * Legacy visible-message count. Not a hard tail slice: under the token
   * budget it must not drop the latest user message.
   */
  maxVisibleMessages?: number;
  /** Consult shouldLatchBeforeTools / decideHitlLatch. Default true. */
  hitlLatch?: boolean;
  recoveryEnabled?: boolean;
  spinWatchdog?: boolean;
  spinWatchdogMaxConsecutive?: number;
  /**
   * On context overflow: force compact, then re-run prepare (fold clamp + view +
   * appendix), not compact alone. Default true.
   */
  overflowReprepare?: boolean;
  modelName?: string;
  refusalPreservation?: boolean;
  /** Successful tool names that end the run (`stop_at:<name>`). */
  stopAtToolNames?: string[];
  /**
   * Last finite turn: empty tools so the model must answer.
   * Default true (chrome distill / last-call reservation).
   */
  forceAnswerOnLastTurn?: boolean;
  /**
   * Overflow re-prepare skips memory / working-log appendix. Default true.
   */
  overflowSkipAppendix?: boolean;
  /** Extra suffix mixed into the provider prompt-cache key. */
  promptCacheBustKey?: string;
  /** Token budget for RiskEngine `budget_high`. Omit / ≤0 disables. */
  budgetTokens?: number;
  /** Last-turn system suffix. Empty/omitted uses LAST_TURN_NUDGE. */
  lastTurnNudge?: string;
  /** Last-turn fallback assistant text. Empty/omitted uses LAST_TURN_FALLBACK. */
  lastTurnFallback?: string;
}

export interface ResolvedLoopConfig {
  maxTurns?: number;
  maxContextTokens?: number;
  compactEveryTurn: boolean;
  foldBudgetClamp: boolean;
  maxVisibleMessages: number;
  hitlLatch: boolean;
  recoveryEnabled: boolean;
  spinWatchdog: boolean;
  spinWatchdogMaxConsecutive: number;
  overflowReprepare: boolean;
  modelName?: string;
  refusalPreservation: boolean;
  stopAtToolNames: string[];
  forceAnswerOnLastTurn: boolean;
  overflowSkipAppendix: boolean;
  promptCacheBustKey?: string;
  budgetTokens?: number;
  lastTurnNudge: string;
  lastTurnFallback: string;
}

export const LAST_TURN_NUDGE =
  'This is the last turn; tools are closed. Answer from existing results. State what was not completed. Do not invent success.';

export const LAST_TURN_FALLBACK =
  'Reached the turn limit without a complete answer. Retry; completed work is in the trace.';

export const DEFAULT_LOOP_CONFIG: ResolvedLoopConfig = {
  compactEveryTurn: true,
  foldBudgetClamp: true,
  maxVisibleMessages: MAX_VISIBLE_MESSAGES,
  hitlLatch: true,
  recoveryEnabled: true,
  spinWatchdog: true,
  spinWatchdogMaxConsecutive: 3,
  overflowReprepare: true,
  refusalPreservation: true,
  stopAtToolNames: [],
  forceAnswerOnLastTurn: true,
  overflowSkipAppendix: true,
  lastTurnNudge: LAST_TURN_NUDGE,
  lastTurnFallback: LAST_TURN_FALLBACK
};

/** `<=0` / non-finite means unlimited (chrome distill `resolveMaxTurns`). */
export function resolveTurnCap(maxTurns: number | undefined): number {
  if (maxTurns == null || maxTurns <= 0 || !Number.isFinite(maxTurns)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(maxTurns);
}

export function resolveLoopConfig(
  ...sources: Array<LoopConfig | undefined>
): ResolvedLoopConfig {
  const merged: LoopConfig = {};
  for (const source of sources) {
    if (!source) continue;
    Object.assign(merged, source);
  }
  const budget =
    typeof merged.budgetTokens === 'number' && merged.budgetTokens > 0
      ? merged.budgetTokens
      : undefined;
  return {
    maxTurns: merged.maxTurns,
    maxContextTokens: merged.maxContextTokens ?? DEFAULT_LOOP_CONFIG.maxContextTokens,
    compactEveryTurn: merged.compactEveryTurn ?? DEFAULT_LOOP_CONFIG.compactEveryTurn,
    foldBudgetClamp: merged.foldBudgetClamp ?? DEFAULT_LOOP_CONFIG.foldBudgetClamp,
    maxVisibleMessages: merged.maxVisibleMessages ?? DEFAULT_LOOP_CONFIG.maxVisibleMessages,
    hitlLatch: merged.hitlLatch ?? DEFAULT_LOOP_CONFIG.hitlLatch,
    recoveryEnabled: merged.recoveryEnabled ?? DEFAULT_LOOP_CONFIG.recoveryEnabled,
    spinWatchdog: merged.spinWatchdog ?? DEFAULT_LOOP_CONFIG.spinWatchdog,
    spinWatchdogMaxConsecutive:
      merged.spinWatchdogMaxConsecutive ?? DEFAULT_LOOP_CONFIG.spinWatchdogMaxConsecutive,
    overflowReprepare: merged.overflowReprepare ?? DEFAULT_LOOP_CONFIG.overflowReprepare,
    modelName: merged.modelName,
    refusalPreservation: merged.refusalPreservation ?? DEFAULT_LOOP_CONFIG.refusalPreservation,
    stopAtToolNames: merged.stopAtToolNames ? [...merged.stopAtToolNames] : [],
    forceAnswerOnLastTurn: merged.forceAnswerOnLastTurn ?? DEFAULT_LOOP_CONFIG.forceAnswerOnLastTurn,
    overflowSkipAppendix: merged.overflowSkipAppendix ?? DEFAULT_LOOP_CONFIG.overflowSkipAppendix,
    promptCacheBustKey: merged.promptCacheBustKey,
    budgetTokens: budget,
    lastTurnNudge: merged.lastTurnNudge?.trim() || LAST_TURN_NUDGE,
    lastTurnFallback: merged.lastTurnFallback?.trim() || LAST_TURN_FALLBACK
  };
}

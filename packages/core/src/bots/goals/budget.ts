import type { KernelHookListener } from '@ppeng/agent-loop';
import type { GoalRuntimeHost } from './runtime-host.js';
import type { GoalReport } from './types.js';

/**
 * Spend stays on the goal (`costUsd`). Reaching the stored budget must not
 * block the goal, drain a wait, or cancel the session.
 */
export function observeGoalBudget(_host: GoalRuntimeHost, _sessionId: string): KernelHookListener {
  return () => {};
}

/** Settlement must not rewrite a report into a budget stop. */
export function preserveGoalBudgetReport(_host: GoalRuntimeHost, _sessionId: string, report: GoalReport): GoalReport {
  return report;
}

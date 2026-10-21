import type { GoalSettings, GoalStore } from './types.js';
const KEY = 'bot_multi_goal_settings';
export const DEFAULT_GOAL_SETTINGS: GoalSettings = { maxConcurrent: 4, defaultBudgetUsd: 10, maxAttempts: 20, maxNoProgress: 3, leaseMs: 300000, preferredStrategy: 'auto' };
export function readGoalSettings(store: GoalStore, scope?: string): GoalSettings { return { ...DEFAULT_GOAL_SETTINGS, ...store.getDaemonControl<Partial<GoalSettings>>(scope ? `${KEY}:${scope}` : KEY) }; }
export function writeGoalSettings(store: GoalStore, patch: Partial<GoalSettings>, scope?: string): GoalSettings {
 for (const key of Object.keys(patch)) if (!(key in DEFAULT_GOAL_SETTINGS)) throw new Error(`Unknown setting ${key}`);
 const next = { ...readGoalSettings(store, scope), ...patch };
 for (const key of ['maxConcurrent','maxAttempts','maxNoProgress','leaseMs'] as const) {
  if (!Number.isSafeInteger(next[key]) || next[key] < 1) throw new Error(`Invalid ${key}`);
 }
 if (!Number.isFinite(next.defaultBudgetUsd) || next.defaultBudgetUsd <= 0) throw new Error('Invalid defaultBudgetUsd');
 if (!['auto','direct','subagent','bot_delegate','ptc','team_dag','swarm','browser','computer','deep_research'].includes(next.preferredStrategy)) throw new Error('Invalid preferredStrategy');
 store.setDaemonControl(scope ? `${KEY}:${scope}` : KEY, next); return next;
}

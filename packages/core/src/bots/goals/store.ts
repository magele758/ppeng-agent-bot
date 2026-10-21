import type { GoalSnapshot, GoalStore } from './types.js';
export function readGoalSnapshot(store: GoalStore, botId: string): GoalSnapshot {
 return store.getDaemonControl<GoalSnapshot>(`bot_goals:${botId}`) ?? { goals: [], executions: [], events: [], processed: [], fence: 0 };
}
export function mutateGoalSnapshot<T>(store: GoalStore, botId: string, fn: (state: GoalSnapshot) => T): T {
 store.db?.exec('SAVEPOINT bot_goal_mutation');
 try {
  const state = readGoalSnapshot(store, botId); const result = fn(state);
  store.setDaemonControl(`bot_goals:${botId}`, state); store.db?.exec('RELEASE bot_goal_mutation'); return result;
 } catch(error) { store.db?.exec('ROLLBACK TO bot_goal_mutation'); store.db?.exec('RELEASE bot_goal_mutation'); throw error; }
}

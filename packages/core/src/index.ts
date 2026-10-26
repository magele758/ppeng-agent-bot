export { resolveSessionBotGoal, goalScope } from './bots/goals/runtime-host.js';
/**
 * `@ppeng/agent-core` main entry — **whitelist only**.
 *
 * Stable surface lives in `./exports/public.ts`. This file does not
 * `export *` from `stores/*`, `storage.ts`, or sandbox provider modules.
 * Third parties that need WAL/store internals must use a deep path or
 * `@ppeng/agent-core/session` (`SessionSurfaceStore`), not this barrel.
 */
export * from './exports/public.js';

export { FactoryService } from './factory/service.js';
export type { FactoryMachine, FactoryTask, FactorySettings, FactoryTransport } from './factory/types.js';

export type { DevelopmentPolicy, DevelopmentSpec, DevelopmentState, DevelopmentPreflight } from './factory/development-types.js';
export { BotGoalService } from './bots/goals/service.js';
export type { BotGoal, GoalSettings, GoalReport } from './bots/goals/types.js';

export { updateTaskContract, contractAppendix, type TaskContract } from './session/task-contract.js';

export {LearningService} from './learning/service.js';
export {SourceLedger} from './learning/sources.js';
export {StepInboxStore} from './session/step-inbox.js';

/**
 * Portable mini entry — kernel + memory store + recover / HITL / pack.
 * Do not import `./index.js` or `createAssembledLoop` from here (dispatcher
 * pulls normal/full/max; bundlers follow those dynamic imports into node:fs).
 */

export { createMiniAssembledLoop } from './assembly/mini-host.js';
export {
  LOOP_MODULES,
  LOOP_PRESETS,
  isLoopPreset,
  moduleIdsForPreset,
  modulesForPreset,
  parseLoopPreset,
  presetAtLeast,
} from './assembly/presets.js';
export type { LoopModuleMeta, LoopPreset } from './assembly/presets.js';
export type { AssembledLoop, AssembledLoopIo, CreateAssembledLoopInput } from './assembly/io.js';
export { runSessionKernel } from './turn/kernel.js';
export type { AgentLoopLatch, TurnKernelOptions } from './turn/kernel.js';
export { DEFAULT_LOOP_CONFIG, resolveLoopConfig, resolveTurnCap } from './turn/config.js';
export type { LoopConfig, ResolvedLoopConfig } from './turn/config.js';
export { defaultPrepareView } from './turn/default-view.js';
export {
  lastUserQueryFromMessages,
  prepareTurnInput,
} from './turn/prepare-turn-input.js';
export { createKernelHookRegistry } from './turn/hooks.js';
export { createMemorySurfaceStore } from './session/surface-store.js';
export { decideHitlLatch } from './approval/hitl-latch.js';
export { DEFAULT_EMBED_AGENT, adaptMemoryStore, createDefaultMemoryStore } from './assembly/store-adapter.js';
export * from './durable/index.js';

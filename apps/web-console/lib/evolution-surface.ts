import { EVOLUTION_SURFACE_ENABLED } from '../../../packages/core/src/evolution/surface.ts';

export { EVOLUTION_SURFACE_ENABLED };

/** Top-bar chip. Hidden while the product switch is off, even if a worktree is active. */
export function evolutionChipVisible(activeWorktrees: number): boolean {
  return EVOLUTION_SURFACE_ENABLED && activeWorktrees > 0;
}

/** Health card, nav affordance, and the old Evolution console. */
export function evolutionEntryVisible(): boolean {
  return EVOLUTION_SURFACE_ENABLED;
}

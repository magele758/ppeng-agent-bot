/**
 * Keep equal to `EVOLUTION_SURFACE_ENABLED` in
 * `packages/core/src/evolution/surface.ts`.
 * The Lab image does not COPY `packages/core` (see deploy/docker/Dockerfile.web),
 * so this boolean lives here. A unit test asserts the two values match.
 */
export const EVOLUTION_SURFACE_ENABLED = false;

/** Top-bar chip. Hidden while the product switch is off, even if a worktree is active. */
export function evolutionChipVisible(activeWorktrees: number): boolean {
  return EVOLUTION_SURFACE_ENABLED && activeWorktrees > 0;
}

/** Health card, nav affordance, and the old Evolution console. */
export function evolutionEntryVisible(): boolean {
  return EVOLUTION_SURFACE_ENABLED;
}

/**
 * Child abort signals (steer scope, PTC cell) are not the session controller.
 * Link them so a turn stop can still reach that controller.
 * AbortSignal.any does not expose its parents.
 */

const parentOf = new WeakMap<AbortSignal, AbortSignal>();

export function linkAbortParent(child: AbortSignal, parent: AbortSignal | undefined): void {
  if (!parent || child === parent || parentOf.has(child)) return;
  parentOf.set(child, parent);
}

/** Walk to the signal captured for this turn. Unlinked signals are themselves. */
export function turnAbortSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  let current = signal;
  const seen = new Set<AbortSignal>();
  while (current && parentOf.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parentOf.get(current);
  }
  return current;
}

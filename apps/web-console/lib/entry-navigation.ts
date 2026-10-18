/** Keyboard navigation shared by the create menu and focused create dialogs. */
export function nextMenuIndex(key: string, current: number, count: number): number {
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const delta = key === 'ArrowUp' ? -1 : 1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return (current + delta + count) % count;
}

/** Null means normal browser tab navigation can continue. */
export function dialogTabTarget<T>(items: readonly T[], current: T | null, inside: boolean, backwards: boolean): T | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (!first) return null;
  if (!inside) return backwards ? last : first;
  if (backwards && current === first) return last;
  if (!backwards && current === last) return first;
  return null;
}

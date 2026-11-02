export function shownGroupMembers<T>(members: readonly T[]): T[] {
  return members.slice(0, 4);
}

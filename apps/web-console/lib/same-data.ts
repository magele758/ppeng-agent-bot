/** True when two JSON snapshots carry the same data. Used to skip poll setState. */
export function sameData(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Same idea as `lab.locale`: a local UI preference, not an env flag. */
export const RAIL_COLLAPSED_STORAGE_KEY = 'lab.railCollapsed';

export function parseRailCollapsed(value: unknown): boolean {
  return value === '1' || value === 'true';
}

export function readRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return parseRailCollapsed(window.localStorage.getItem(RAIL_COLLAPSED_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writeRailCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* private mode / quota */
  }
}

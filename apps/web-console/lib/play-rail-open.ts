/** Chat-page right rail (activity / context / …) preference. Not the icon rail (`lab.railCollapsed`). */
export const PLAY_RAIL_OPEN_STORAGE_KEY = 'lab.playRailOpen';

export function readPlayRailOpen(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(PLAY_RAIL_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePlayRailOpen(
  open: boolean,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(PLAY_RAIL_OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* private mode / quota */
  }
}

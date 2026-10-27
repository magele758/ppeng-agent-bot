/** Conversation session list preference. Same idea as `lab.locale`, not the icon rail. */
export const PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY = 'lab.playSidebarCollapsed';

export function parsePlaySidebarCollapsed(value: unknown): boolean {
  return value === '1' || value === 'true';
}

export function readPlaySidebarCollapsed(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): boolean {
  if (!storage) return false;
  try {
    return parsePlaySidebarCollapsed(storage.getItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writePlaySidebarCollapsed(
  collapsed: boolean,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): void {
  if (!storage) return;
  try {
    storage.setItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* private mode / quota */
  }
}

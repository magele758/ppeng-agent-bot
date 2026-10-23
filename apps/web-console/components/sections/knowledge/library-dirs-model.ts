export type LibraryPickApply =
  | { action: 'save'; dirs: string[] }
  | { action: 'duplicate' }
  | { action: 'cancelled' }
  | { action: 'unavailable' }
  | { action: 'rejected' }
  | { action: 'ignore' };

export function normalizeLibraryDir(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/\/+$/, '');
}

function pickStatus(result: unknown): 'selected' | 'cancelled' | 'unavailable' | 'rejected' | 'other' {
  if (!result || typeof result !== 'object') return 'other';
  const status = (result as { status?: unknown }).status;
  if (status === 'selected' || status === 'cancelled' || status === 'unavailable' || status === 'rejected') {
    return status;
  }
  return 'other';
}

function selectedPath(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const path = (result as { path?: unknown }).path;
  if (typeof path !== 'string') return '';
  const normalized = normalizeLibraryDir(path);
  if (!normalized.startsWith('/')) return '';
  return normalized;
}

/** Append one chosen folder. Cancel, failure, and duplicates do not change the list. */
export function applyLibraryPick(dirs: readonly string[], result: unknown): LibraryPickApply {
  const status = pickStatus(result);
  switch (status) {
    case 'selected': {
      const path = selectedPath(result);
      if (!path) return { action: 'ignore' };
      if (dirs.some((dir) => normalizeLibraryDir(dir) === path)) return { action: 'duplicate' };
      return { action: 'save', dirs: [...dirs.map((dir) => normalizeLibraryDir(dir)), path] };
    }
    case 'cancelled':
      return { action: 'cancelled' };
    case 'unavailable':
      return { action: 'unavailable' };
    case 'rejected':
      return { action: 'rejected' };
    case 'other':
      return { action: 'ignore' };
    default: {
      const never: never = status;
      return never;
    }
  }
}

export function withoutLibraryDir(dirs: readonly string[], path: string): string[] {
  const target = normalizeLibraryDir(path);
  return dirs.filter((dir) => normalizeLibraryDir(dir) !== target);
}

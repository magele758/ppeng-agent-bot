export type LibraryPickApply =
  | { action: 'save'; dirs: string[] }
  | { action: 'duplicate' }
  | { action: 'cancelled' }
  | { action: 'unavailable' }
  | { action: 'rejected'; reason: string }
  | { action: 'ignore' };

export type LibraryNoticeKey =
  | 'knowledge.library.saved'
  | 'knowledge.library.removed'
  | 'knowledge.library.saveFailed'
  | 'knowledge.library.missing'
  | 'knowledge.library.unreadable'
  | 'knowledge.library.denied'
  | 'knowledge.library.notFolder'
  | 'knowledge.library.rejected';

export type LibrarySaveView =
  | { kind: 'message'; dirs: string[]; messageKey: 'knowledge.library.saved' | 'knowledge.library.removed' }
  | { kind: 'error'; errorKey: LibraryNoticeKey; error?: string };

export interface LibrarySaveInput {
  action: 'saved' | 'removed';
  previous: readonly string[];
  returnedDirs: readonly string[] | null;
  /** Accepted so a still-running index is not a separate failure. */
  indexRunning: boolean;
}

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
      return { action: 'rejected', reason: rejectReason(result) };
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

function rejectReason(result: unknown): string {
  if (!result || typeof result !== 'object') return 'rejected';
  const reason = (result as { reason?: unknown }).reason;
  if (typeof reason !== 'string' || reason.length === 0) return 'rejected';
  return reason;
}

function sameLibraryDirs(left: readonly string[], right: readonly string[]): boolean {
  return left.map(normalizeLibraryDir).join('\n') === right.map(normalizeLibraryDir).join('\n');
}

function stringsOnly(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const dirs: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    dirs.push(item);
  }
  return dirs;
}

function failedSave(error: string): LibrarySaveView {
  return { kind: 'error', errorKey: 'knowledge.library.saveFailed', error };
}

function librarySaveErrorKey(message: string): LibraryNoticeKey | null {
  if (message === 'Folder does not exist') return 'knowledge.library.missing';
  if (message === 'That folder could not be read') return 'knowledge.library.unreadable';
  if (message === 'That folder is not allowed') return 'knowledge.library.denied';
  if (message === 'Path is not a folder') return 'knowledge.library.notFolder';
  return null;
}

export function libraryDirsFromBody(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const settings = (body as { settings?: unknown }).settings;
  if (!settings || typeof settings !== 'object') return null;
  return stringsOnly((settings as { libraryDirs?: unknown }).libraryDirs);
}

export function libraryIndexRunning(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as { index?: unknown; indexing?: unknown };
  if (record.indexing === true) return true;
  return record.index === 'running';
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A saved folder stays saved when the canonical list is unchanged or the index is still running. */
export function librarySaveView(input: LibrarySaveInput): LibrarySaveView {
  void input.indexRunning;
  if (input.returnedDirs == null) return failedSave('not saved');
  if (input.action === 'removed' && sameLibraryDirs(input.returnedDirs, input.previous)) return failedSave('not saved');
  return {
    kind: 'message',
    dirs: [...input.returnedDirs],
    messageKey: input.action === 'saved' ? 'knowledge.library.saved' : 'knowledge.library.removed'
  };
}

/** A dropped request is not a failure when the folder list already matches. Known refusals still show. */
export function librarySaveFailureView(input: {
  action: 'saved' | 'removed';
  intended: readonly string[];
  errorMessage: string;
  loaded: readonly string[] | null;
}): LibrarySaveView {
  const key = librarySaveErrorKey(input.errorMessage);
  if (key) return { kind: 'error', errorKey: key };
  if (input.loaded != null && sameLibraryDirs(input.loaded, input.intended)) {
    return {
      kind: 'message',
      dirs: [...input.loaded],
      messageKey: input.action === 'saved' ? 'knowledge.library.saved' : 'knowledge.library.removed'
    };
  }
  return failedSave(input.errorMessage);
}

export function libraryRejectKey(reason: string): LibraryNoticeKey {
  if (reason === 'missing') return 'knowledge.library.missing';
  if (reason === 'unreadable') return 'knowledge.library.unreadable';
  if (reason === 'denied') return 'knowledge.library.denied';
  if (reason === 'not-folder') return 'knowledge.library.notFolder';
  return 'knowledge.library.rejected';
}

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { sensitiveReadRefusal } from '../workspace/sensitive-read.js';

export const LIBRARY_DIR_LIMIT = 20;

export type LibraryDirCode = 'empty' | 'relative' | 'missing' | 'unreadable' | 'not-folder' | 'denied';

export type LibraryDirCheck = { ok: true; path: string } | { ok: false; code: LibraryDirCode; error: string };

const LIBRARY_DIR_ERROR: Record<LibraryDirCode, string> = {
  empty: 'Enter a folder path',
  relative: 'Folder path must be absolute',
  missing: 'Folder does not exist',
  unreadable: 'That folder could not be read',
  'not-folder': 'Path is not a folder',
  denied: 'That folder is not allowed'
};

function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(home, input.slice(2));
  return input;
}

/** `/var` and `/private/var` must agree before blocked-prefix checks. */
function canonicalHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

function fail(code: LibraryDirCode): LibraryDirCheck {
  return { ok: false, code, error: LIBRARY_DIR_ERROR[code] };
}

function denied(path: string, root: string): LibraryDirCheck | null {
  if (sensitiveReadRefusal(path, root, 'directory')) return fail('denied');
  return null;
}

function realpathFailure(code: string | undefined, expanded: string, root: string): LibraryDirCheck {
  if (code === 'ENOENT') return fail('missing');
  return denied(expanded, root) ?? fail('unreadable');
}

function inspectedDir(real: string, root: string): LibraryDirCheck {
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    return denied(real, root) ?? fail('unreadable');
  }
  if (!isDir) return fail('not-folder');
  return denied(real, root) ?? { ok: true, path: real };
}

function readRealpath(expanded: string): { ok: true; path: string } | { ok: false; code?: string } {
  try {
    return { ok: true, path: realpathSync(expanded) };
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code };
  }
}

/** Accept one user-entered folder. Relative paths and blocked locations are refused. */
export function checkLibraryDir(input: string, home = homedir()): LibraryDirCheck {
  const root = canonicalHome(home);
  const raw = input.trim();
  if (!raw) return fail('empty');
  const expanded = expandHome(raw, root);
  if (!isAbsolute(expanded)) return fail('relative');
  const real = readRealpath(expanded);
  if (!real.ok) return realpathFailure(real.code, expanded, root);
  return inspectedDir(real.path, root);
}

export function prepareLibraryDirs(
  input: unknown,
  home = homedir()
): { ok: true; dirs: string[] } | { ok: false; error: string } {
  const root = canonicalHome(home);
  if (!Array.isArray(input)) return { ok: false, error: 'libraryDirs must be a list of paths' };
  if (input.length > LIBRARY_DIR_LIMIT) return { ok: false, error: 'At most 20 folders' };
  const dirs: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') return { ok: false, error: 'libraryDirs must be a list of paths' };
    const checked = checkLibraryDir(item, root);
    if (!checked.ok) return checked;
    if (!dirs.includes(checked.path)) dirs.push(checked.path);
  }
  return { ok: true, dirs };
}

/** Keep already-saved folders. Drop anything that is not an absolute allowed path. */
export function storedLibraryDirs(raw: unknown, home = homedir()): string[] {
  const root = canonicalHome(home);
  if (!Array.isArray(raw)) return [];
  const dirs: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const path = item.trim();
    if (!path || !isAbsolute(path)) continue;
    if (sensitiveReadRefusal(path, root, 'directory')) continue;
    if (!dirs.includes(path)) dirs.push(path);
  }
  return dirs.slice(0, LIBRARY_DIR_LIMIT);
}

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { sensitiveReadRefusal } from '../workspace/sensitive-read.js';

export const LIBRARY_DIR_LIMIT = 20;

export type LibraryDirCheck = { ok: true; path: string } | { ok: false; error: string };

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

/** Accept one user-entered folder. Relative paths and blocked locations are refused. */
export function checkLibraryDir(input: string, home = homedir()): LibraryDirCheck {
  const root = canonicalHome(home);
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Enter a folder path' };
  const expanded = expandHome(raw, root);
  if (!isAbsolute(expanded)) return { ok: false, error: 'Folder path must be absolute' };
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: 'Folder does not exist' };
    return { ok: false, error: 'That folder is not allowed' };
  }
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    return { ok: false, error: 'That folder is not allowed' };
  }
  if (!isDir) return { ok: false, error: 'Path is not a folder' };
  if (sensitiveReadRefusal(real, root, 'directory')) return { ok: false, error: 'That folder is not allowed' };
  return { ok: true, path: real };
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

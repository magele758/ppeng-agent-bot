/**
 * String containment for Pattern B writable boundaries.
 * Does not start a sandbox. Hosts supply realpath via BoundaryRegistry.canonicalize.
 */

const POSIX_SEP = '/';

function isAbsolutePosix(path: string): boolean {
  return path.startsWith(POSIX_SEP);
}

/** Collapse `.`, `..`, and extra `/` the way path.posix.normalize does on Linux. */
function normalizePosix(path: string): string {
  const hadTrailingSlash = path.endsWith(POSIX_SEP);
  const out: string[] = [];
  for (const part of path.split(POSIX_SEP)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return POSIX_SEP;
  const normalized = POSIX_SEP + out.join(POSIX_SEP);
  return hadTrailingSlash ? `${normalized}${POSIX_SEP}` : normalized;
}

export function canonicalPath(input: string): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed || !isAbsolutePosix(trimmed)) return undefined;
  const norm = normalizePosix(trimmed);
  if (norm.length > 1 && norm.endsWith(POSIX_SEP)) return norm.slice(0, -1);
  return norm;
}

/** True when target is root or a path strictly inside root. Prefix tricks do not match. */
export function pathContained(root: string, target: string): boolean {
  const base = canonicalPath(root);
  const leaf = canonicalPath(target);
  if (!base || !leaf) return false;
  return leaf === base || leaf.startsWith(base + POSIX_SEP);
}

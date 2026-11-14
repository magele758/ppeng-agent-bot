/**
 * String containment for Pattern B writable boundaries.
 * Does not start a sandbox. Hosts supply realpath via BoundaryRegistry.canonicalize.
 */
import { isAbsolute, normalize, sep } from 'node:path';

export function canonicalPath(input: string): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed || !isAbsolute(trimmed)) return undefined;
  const norm = normalize(trimmed);
  if (norm.length > 1 && norm.endsWith(sep)) return norm.slice(0, -1);
  return norm;
}

/** True when target is root or a path strictly inside root. Prefix tricks do not match. */
export function pathContained(root: string, target: string): boolean {
  const base = canonicalPath(root);
  const leaf = canonicalPath(target);
  if (!base || !leaf) return false;
  return leaf === base || leaf.startsWith(base + sep);
}

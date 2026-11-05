/**
 * Bot skill allowlist (`session.metadata.allowedSkills`). Empty / missing means
 * every skill. It narrows the same catalog the shortlist, search_skills and
 * load_skill read, and is independent of the user-level `skillScope`.
 */

import { ValidationError } from '../errors.js';

export function readAllowedSkillNames(
  metadata: Record<string, unknown> | undefined
): string[] | undefined {
  const raw = metadata?.allowedSkills;
  if (!Array.isArray(raw)) return undefined;
  const names = raw
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim());
  return names.length > 0 ? names : undefined;
}

export function filterSkillsByAllowlist<T extends { name: string }>(
  skills: T[],
  allowed: readonly string[] | undefined
): T[] {
  if (!allowed || allowed.length === 0) return skills;
  return skills.filter((skill) => isSkillAllowed(skill, allowed));
}

export function isSkillAllowed(
  skill: { name: string; id?: string; aliases?: string[] },
  allowed: readonly string[] | undefined
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const allow = new Set(allowed.map((name) => name.trim().toLowerCase()));
  return [skill.name, skill.id, ...(skill.aliases ?? [])].some(
    (key) => typeof key === 'string' && allow.has(key.trim().toLowerCase())
  );
}

/** Canonical skill names, de-duplicated. Unknown names are rejected. */
export function normalizeAllowedSkillNames(
  raw: unknown,
  catalog: readonly { name: string }[]
): string[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError('allowedSkills must be an array of skill names');
  }
  const byLower = new Map(catalog.map((skill) => [skill.name.trim().toLowerCase(), skill.name]));
  const names: string[] = [];
  const unknown: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      unknown.push(String(item));
      continue;
    }
    const name = item.trim();
    if (!name) continue;
    const canonical = byLower.get(name.toLowerCase());
    if (!canonical) unknown.push(name);
    else if (!names.includes(canonical)) names.push(canonical);
  }
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown skills: ${unknown.join(', ')}`);
  }
  return names;
}

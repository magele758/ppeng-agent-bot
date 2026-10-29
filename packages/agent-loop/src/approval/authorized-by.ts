/**
 * Audit citation on a mutating tool call.
 * Owner message ids (tNu…) and answered-card ids (tNsM…) are stored as given.
 * A helper may only pass p-prefixed ids its parent already handed it; this
 * helper does not read chat history or invent ids.
 *
 * Keep the cap and id rule aligned with packages/core/src/approval/authorized-by.ts.
 */
export const AUTHORIZED_BY_LIMIT = 4;

const STABLE_ID = /^\S{1,128}$/;

export function normalizeAuthorizedBy(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!STABLE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === AUTHORIZED_BY_LIMIT) break;
  }
  return ids.length > 0 ? ids : undefined;
}

/** Read the citation off a tool input. Missing or empty stays absent. */
export function readAuthorizedBy(input: unknown): string[] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  return normalizeAuthorizedBy(rec.authorizedBy ?? rec.authorized_by);
}

/**
 * Audit citation stored on an approval receipt.
 * Keep the cap and id rule aligned with packages/agent-loop/src/approval/authorized-by.ts.
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

export function authorizedByFromJson(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    return normalizeAuthorizedBy(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

import { ValidationError } from '@ppeng/agent-core';

export function favoritePatchFromBody(body: unknown): { favorited: boolean } | undefined {
  const record = recordBody(body);
  if (!record || !hasFavorited(record)) return undefined;
  if (typeof record.favorited !== 'boolean') throw new ValidationError('favorited must be a boolean');
  return { favorited: record.favorited };
}

function recordBody(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

function hasFavorited(record: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(record, 'favorited');
}

export function applySessionFavorite(
  runtime: { mergeSessionMetadata(id: string, patch: Record<string, unknown>): unknown },
  id: string,
  body: unknown
): void {
  const patch = favoritePatchFromBody(body);
  if (!patch) return;
  runtime.mergeSessionMetadata(id, patch);
}

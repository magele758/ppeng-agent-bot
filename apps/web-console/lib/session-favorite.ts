import { filterSessionsByQuery, type SessionSearchable } from '@ppeng/api-types';
import { groupSessionsByDate } from './session-groups.ts';

export type FavoriteSession = {
  id: string;
  metadata?: Record<string, unknown>;
};

export type SessionGroup<T> = { bucket: string; label: string; sessions: T[] };

export function sessionIsFavorited(session: FavoriteSession | null | undefined): boolean {
  return session?.metadata?.favorited === true;
}

export function withSessionFavorite<T extends FavoriteSession>(session: T, favorited: boolean): T {
  return { ...session, metadata: { ...metadataOf(session), favorited } };
}

function metadataOf(session: FavoriteSession): Record<string, unknown> {
  if (session.metadata) return session.metadata;
  return {};
}

export function favoriteRequest(sessionId: string, favorited: boolean): { path: string; init: RequestInit } {
  return {
    path: `/api/sessions/${encodeURIComponent(sessionId)}`,
    init: {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ favorited })
    }
  };
}

export async function saveSessionFavorite<T extends FavoriteSession>(
  session: T,
  favorited: boolean,
  request: (path: string, init: RequestInit) => Promise<unknown>
): Promise<T> {
  const spec = favoriteRequest(session.id, favorited);
  await request(spec.path, spec.init);
  return withSessionFavorite(session, favorited);
}

export function filterFavoriteSessions<T extends FavoriteSession>(sessions: readonly T[], onlyFavorites: boolean): T[] {
  if (!onlyFavorites) return [...sessions];
  return sessions.filter((session) => sessionIsFavorited(session));
}

export function sessionsForSidebar<T extends SessionSearchable & FavoriteSession>(
  sessions: readonly T[],
  query: string,
  favoritesOnly: boolean
): T[] {
  return filterFavoriteSessions(filterSessionsByQuery(sessions, query), favoritesOnly);
}

export function groupSessionsWithFavorites<T extends FavoriteSession & { updatedAt?: string; createdAt?: string }>(
  sessions: readonly T[],
  now = Date.now()
): SessionGroup<T>[] {
  const favorites = sessions.filter((session) => sessionIsFavorited(session));
  const rest = groupSessionsByDate(
    sessions.filter((session) => !sessionIsFavorited(session)),
    now
  );
  return prependFavoriteGroup(favorites, rest);
}

function prependFavoriteGroup<T>(favorites: readonly T[], rest: SessionGroup<T>[]): SessionGroup<T>[] {
  if (!favorites.length) return rest;
  return [{ bucket: 'favorites', label: '', sessions: [...favorites] }, ...rest];
}

export function sessionListEmptyText(
  input: { botSurface: boolean; favoritesOnly: boolean },
  text: { noBots: string; noSessions: string; noFavorites: string }
): string {
  if (input.botSurface) return text.noBots;
  if (input.favoritesOnly) return text.noFavorites;
  return text.noSessions;
}

export function replaceSessionSummary<T extends { id: string }>(session: T, id: string, patch: (session: T) => T): T {
  if (session.id !== id) return session;
  return patch(session);
}

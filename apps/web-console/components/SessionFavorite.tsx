'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  saveSessionFavorite,
  sessionIsFavorited,
  type FavoriteSession
} from '@/lib/session-favorite';

function FavoriteBookmark({ filled }: { filled?: boolean }) {
  const on = filled === true;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  );
}

export function SessionFavoriteMark({ session }: { session: FavoriteSession }) {
  const { t } = useI18n();
  if (!sessionIsFavorited(session)) return null;
  const label = t('play.favorite.saved');
  return (
    <span className="session-item__favorite" data-testid="session-favorite-mark" title={label} aria-label={label}>
      <FavoriteBookmark filled />
    </span>
  );
}

function favoriteFilterClass(pressed: boolean): string {
  const base = 'btn btn-ghost btn-sm session-favorite-filter';
  if (!pressed) return base;
  return `${base} is-on`;
}

export function SessionFavoriteFilter({
  pressed,
  onChange
}: {
  pressed: boolean;
  onChange?: (next: boolean) => void;
}) {
  const { t } = useI18n();
  if (!onChange) return null;
  const label = t('play.sidebar.favoritesOnly');
  return (
    <button
      type="button"
      className={favoriteFilterClass(pressed)}
      data-testid="session-favorite-filter"
      aria-pressed={pressed}
      title={label}
      aria-label={label}
      onClick={() => onChange(!pressed)}
    >
      <FavoriteBookmark filled={pressed} />
      <span>{label}</span>
    </button>
  );
}

function favoriteButtonClass(saved: boolean): string {
  const base = 'btn btn-ghost btn-sm session-favorite';
  if (!saved) return base;
  return `${base} is-on`;
}

function favoriteButtonLabel(saved: boolean, t: (key: 'play.favorite.save' | 'play.favorite.saved') => string): string {
  if (saved) return t('play.favorite.saved');
  return t('play.favorite.save');
}

function deliverFavorite(session: FavoriteSession, onUpdated?: (session: FavoriteSession) => void): void {
  if (!onUpdated) return;
  onUpdated(session);
}

function deliverFavoriteFailure(error: unknown, onFailed?: (detail: string) => void): void {
  if (!onFailed) return;
  onFailed(error instanceof Error ? error.message : String(error));
}

async function toggleFavorite(
  session: FavoriteSession,
  setPending: (pending: boolean) => void,
  onUpdated?: (session: FavoriteSession) => void,
  onFailed?: (detail: string) => void
): Promise<void> {
  setPending(true);
  try {
    const updated = await saveSessionFavorite(session, !sessionIsFavorited(session), api);
    deliverFavorite(updated, onUpdated);
  } catch (error) {
    deliverFavoriteFailure(error, onFailed);
  } finally {
    setPending(false);
  }
}

export function SessionFavoriteButton({
  session,
  onUpdated,
  onFailed
}: {
  session: FavoriteSession | null;
  onUpdated?: (session: FavoriteSession) => void;
  onFailed?: (detail: string) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  if (!session) return null;
  const saved = sessionIsFavorited(session);
  const label = favoriteButtonLabel(saved, t);
  return (
    <button
      type="button"
      className={favoriteButtonClass(saved)}
      data-testid="session-favorite"
      aria-pressed={saved}
      disabled={pending}
      title={label}
      aria-label={label}
      onClick={() => { void toggleFavorite(session, setPending, onUpdated, onFailed); }}
    >
      <FavoriteBookmark filled={saved} />
      <span>{label}</span>
    </button>
  );
}

'use client';

import { useI18n } from '@/lib/i18n';
import type { AuthUser } from '@/lib/auth';
import './auth.css';

export function AccountMenu({ user, compact = false }: { user: AuthUser; compact?: boolean }) {
  const { t } = useI18n();
  const label = user.displayName || user.email || user.id;
  const signOut = t('auth.signOut');
  return (
    <div className="account-menu" title={user.email || undefined}>
      {user.avatarUrl ? (
        <img className="account-menu__avatar" src={user.avatarUrl} alt="" />
      ) : (
        <span className="account-menu__initial" aria-hidden="true">
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="account-menu__name">{t('auth.signedInAs', { name: label })}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={signOut}
        title={signOut}
        onClick={() => {
          void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
            window.location.assign('/');
          });
        }}
      >
        {compact ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6H6v12h3M10 12h8M15 9l3 3-3 3" />
          </svg>
        ) : (
          signOut
        )}
      </button>
    </div>
  );
}

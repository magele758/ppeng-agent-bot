'use client';

import { useI18n } from '@/lib/i18n';
import { isolationClass, isolationLabel, sessionGrantRows, type SessionToolGrant } from '@/lib/session-tool-grant';

export function SessionGrantList({
  sessions,
  onRevoke
}: {
  sessions: readonly { id: string; title?: string; metadata?: unknown }[];
  onRevoke: (sessionId: string, grants: SessionToolGrant[]) => void;
}) {
  const { t } = useI18n();
  const rows = sessionGrantRows(sessions);
  if (!rows.length) return null;
  return (
    <div className="console-grants">
      <p className="console-grants__title">{t('tasks.inbox.grantsTitle')}</p>
      <p className="console-grants__desc">{t('tasks.inbox.grantsDesc')}</p>
      <ul className="console-grants__list">
        {rows.map((row) => (
          <li key={`${row.sessionId}:${row.toolName}:${row.isolation}`} className="console-grants__row">
            <span className="console-grants__session">{row.title}</span>
            <span className={isolationClass(row.isolation)}>
              {row.toolName} · {isolationLabel(row.isolation, t)}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('tasks.inbox.revokeAria', { tool: row.toolName })}
              onClick={() => onRevoke(row.sessionId, row.remaining)}
            >
              {t('tasks.inbox.revoke')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

'use client';

import type { ChildTaskStreamEntry } from '@/lib/bot-child-task-stream';
import { useI18n } from '@/lib/i18n';

export function BotChildTaskStreamEntry({
  entries,
  onOpen
}: {
  entries: readonly ChildTaskStreamEntry[];
  onOpen?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <nav className="child-task-stream" data-testid="bot-child-task-stream" aria-label={t('play.childTask.streamLabel')}>
      <span className="child-task-stream__label">{t('play.childTask.streamLabel')}</span>
      <ul className="child-task-stream__list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="child-task-stream__chip"
              data-testid="bot-child-task-stream-entry"
              data-session-id={entry.id}
              aria-label={t('play.childTask.streamOpen', { excerpt: entry.excerpt })}
              onClick={() => onOpen?.(entry.id)}
            >
              {entry.excerpt}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

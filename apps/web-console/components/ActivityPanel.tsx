'use client';

import type { ActivityToolItem } from '@/lib/activity-tools';
import { useI18n } from '@/lib/i18n';
import { BotActivityList } from './BotActivityList';

function phaseLabel(
  phase: ActivityToolItem['phase'],
  t: (key: 'play.activity.announce' | 'play.activity.running' | 'play.activity.error' | 'play.activity.done') => string
): string {
  switch (phase) {
    case 'announce':
      return t('play.activity.announce');
    case 'running':
      return t('play.activity.running');
    case 'error':
      return t('play.activity.error');
    case 'result':
      return t('play.activity.done');
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

function BotWorkSlot({ show, sessionId }: { show?: boolean; sessionId?: string | null }) {
  if (!show || !sessionId) return null;
  return <BotActivityList sessionId={sessionId} />;
}

export function ActivityPanel({
  items,
  emptyHint,
  botSessionId,
  showBotWork
}: {
  items: ActivityToolItem[];
  emptyHint?: string;
  botSessionId?: string | null;
  showBotWork?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="activity-panel" aria-label={t('play.activity.aria')}>
      <BotWorkSlot show={showBotWork} sessionId={botSessionId} />
      <div className="activity-panel__head">
        <h3 className="activity-panel__title">{t('play.rail.activity')}</h3>
        <span className="badge">{items.length}</span>
      </div>
      <div className="activity-panel__list">
        {!items.length ? (
          <div className="empty-hint">{emptyHint ?? t('play.activity.empty')}</div>
        ) : (
          [...items].reverse().map((it) => (
            <details
              key={it.id}
              className={`activity-card activity-card--${it.phase}`}
              open={it.phase === 'running'}
            >
              <summary className="activity-card__summary">
                <span className={`activity-card__phase activity-card__phase--${it.phase}`}>
                  {phaseLabel(it.phase, t)}
                </span>
                <span className="activity-card__name">{it.name}</span>
              </summary>
              {it.argsPreview ? (
                <pre className="activity-card__pre" aria-label={t('play.activity.args')}>
                  {it.argsPreview}
                </pre>
              ) : null}
              {it.resultPreview ? (
                <pre
                  className={`activity-card__pre activity-card__pre--result${it.ok === false ? ' is-err' : ''}`}
                  aria-label={t('play.activity.result')}
                >
                  {it.resultPreview}
                </pre>
              ) : null}
            </details>
          ))
        )}
      </div>
    </div>
  );
}

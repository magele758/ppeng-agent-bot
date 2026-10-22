'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLab } from '@/components/shell/LabProvider';
import { api } from '@/lib/api';
import { activityOpenSessionId, openBotActivitySession, parseBotActivityItems, type BotActivityItem } from '@/lib/bot-activity';
import { useI18n } from '@/lib/i18n';
import { routineStatusPresentation } from '@/lib/routine-status';

const POLL_MS = 3000;

function startedLocale(locale: string): string {
  if (locale === 'zh') return 'zh-CN';
  return 'en';
}

function formatStarted(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return new Intl.DateTimeFormat(startedLocale(locale), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(at);
}

type OpenActivitySession = (sessionId: string, opts?: { focusChat?: boolean }) => void;

export function BotActivityCardView({
  item,
  started,
  statusLabel,
  phaseStatus,
  phaseStyle,
  openLabel,
  onOpenSession
}: {
  item: BotActivityItem;
  started: string;
  statusLabel: string;
  phaseStatus: string;
  phaseStyle: CSSProperties;
  openLabel: string;
  onOpenSession: OpenActivitySession;
}): ReactNode {
  const summary = (
    <span className="activity-card__summary bot-activity__row">
      <span className={`activity-card__phase activity-card__phase--${phaseStatus}`} style={phaseStyle}>{statusLabel}</span>
      <span className="activity-card__name" title={item.title}>{item.title}</span>
    </span>
  );
  const meta = (
    <span className="bot-activity__meta">
      <span className="bot-activity__bot">{item.botName}</span>
      <time className="bot-activity__time" dateTime={item.startedAt}>{started}</time>
    </span>
  );
  const target = activityOpenSessionId(item);
  return (
    <article
      className={`activity-card activity-card--${item.status}`}
      role="listitem"
      {...(target ? {} : { 'aria-label': `${statusLabel} ${item.title}` })}
    >
      {target ? (
        <button
          type="button"
          className="bot-activity__open"
          data-session-id={target}
          aria-label={openLabel}
          onClick={() => {
            openBotActivitySession(onOpenSession, item);
          }}
        >
          {summary}
          {meta}
        </button>
      ) : (
        <>
          {summary}
          {meta}
        </>
      )}
    </article>
  );
}

export function BotActivityRow({
  item,
  started,
  onOpenSession
}: {
  item: BotActivityItem;
  started: string;
  onOpenSession: OpenActivitySession;
}) {
  const { t } = useI18n();
  const outcome = routineStatusPresentation(item.outcomeStatus ?? (item.status === 'running' ? 'running' : 'unknown'));
  const statusLabel = t(outcome.key);
  return (
    <BotActivityCardView
      item={item}
      started={started}
      statusLabel={statusLabel}
      phaseStatus={outcome.status}
      phaseStyle={outcome.style}
      openLabel={t('play.activity.workOpenSession', { status: statusLabel, title: item.title })}
      onOpenSession={onOpenSession}
    />
  );
}

function BotActivityBody({
  items,
  loaded,
  error,
  t,
  locale,
  onOpenSession
}: {
  items: BotActivityItem[];
  loaded: boolean;
  error: boolean;
  t: (key: 'play.activity.workLoadFailed' | 'play.activity.workLoading' | 'play.activity.workEmpty' | 'play.activity.workStarted' | 'play.activity.workRunning' | 'play.activity.workWaiting' | 'play.activity.workDone', vars?: Record<string, string | number>) => string;
  locale: string;
  onOpenSession: OpenActivitySession;
}) {
  if (error) return <div className="empty-hint" role="alert">{t('play.activity.workLoadFailed')}</div>;
  if (!loaded) return <div className="empty-hint">{t('play.activity.workLoading')}</div>;
  if (!items.length) return <div className="empty-hint">{t('play.activity.workEmpty')}</div>;
  return (
    <>
      {items.map((item) => (
        <BotActivityRow
          key={item.id}
          item={item}
          started={t('play.activity.workStarted', { time: formatStarted(item.startedAt, locale) })}
          onOpenSession={onOpenSession}
        />
      ))}
    </>
  );
}

/**
 * In-flight routines and background work for the open bot chat.
 * The session stream does not carry those lifecycle events, so this list polls
 * the read-only activity API. Refresh is the manual backup.
 */
export function BotActivityList({ sessionId }: { sessionId: string }) {
  const { t, locale } = useI18n();
  const { openSession } = useLab();
  const [items, setItems] = useState<BotActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const current = ++ticket.current;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
      if (current !== ticket.current) return;
      setItems(parseBotActivityItems(data));
      setError(false);
      setLoaded(true);
    } catch {
      if (current !== ticket.current) return;
      setError(true);
      setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoaded(false);
    setItems([]);
    setError(false);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      ticket.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  return (
    <div className="activity-panel bot-activity" aria-label={t('play.activity.workAria')}>
      <div className="activity-panel__head">
        <h3 className="activity-panel__title">{t('play.activity.workTitle')}</h3>
        <div className="activity-panel__actions">
          <span className="badge">{items.length}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={refresh}
            disabled={refreshing}
          >
            {t('play.activity.workRefresh')}
          </button>
        </div>
      </div>
      <div className="activity-panel__list" role="list">
        <BotActivityBody items={items} loaded={loaded} error={error} t={t} locale={locale} onOpenSession={openSession} />
      </div>
    </div>
  );
}

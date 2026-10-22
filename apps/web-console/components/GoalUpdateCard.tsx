'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import type { GoalUpdateNotice } from '@/lib/goal-update-notice';

const VERIFY_REASON = 'Completion verification unavailable; evidence retained for review';
const INTERNAL_ID = /^goal_[0-9a-f-]{8,}$/i;

const STATUS_KEY: Record<string, MessageKey> = {
  blocked: 'play.goalUpdate.statusBlocked',
  running: 'play.goalUpdate.statusRunning',
  completed: 'play.goalUpdate.statusCompleted',
  failed: 'play.goalUpdate.statusFailed',
  queued: 'play.goalUpdate.statusQueued',
  waiting: 'play.goalUpdate.statusWaiting',
  paused: 'play.goalUpdate.statusPaused',
  cancelled: 'play.goalUpdate.statusCancelled'
};

type Translate = ReturnType<typeof useI18n>['t'];

function displayTitle(notice: GoalUpdateNotice, fallback: string): string {
  const title = notice.title.trim();
  if (!title || title === notice.id || INTERNAL_ID.test(title)) return fallback;
  return title;
}

function statusLabel(status: string, t: Translate): string {
  const key = STATUS_KEY[status];
  return key ? t(key) : t('play.goalUpdate.statusUnknown');
}

function reasonLabel(reason: string, t: Translate): string {
  const trimmed = reason.trim();
  if (!trimmed) return t('play.goalUpdate.reasonFallback');
  if (trimmed.includes(VERIFY_REASON)) return t('play.goalUpdate.reasonVerifyUnavailable');
  if (/\p{Script=Han}/u.test(trimmed)) return trimmed;
  return t('play.goalUpdate.reasonFallback');
}

export function GoalUpdateCard({ notice }: { notice: GoalUpdateNotice }) {
  const { t } = useI18n();
  const title = displayTitle(notice, t('play.goalUpdate.titleFallback'));
  const status = statusLabel(notice.status, t);
  return (
    <article
      className="goal-update-card"
      data-testid="goal-update-card"
      role="status"
      aria-label={t('play.goalUpdate.cardAria')}
    >
      <strong className="goal-update-card__title" data-testid="goal-update-title">{title}</strong>
      <span className="goal-update-card__status" data-testid="goal-update-status" data-status={notice.status || 'unknown'}>{status}</span>
      <span className="goal-update-card__reason" data-testid="goal-update-reason">{reasonLabel(notice.reason, t)}</span>
    </article>
  );
}

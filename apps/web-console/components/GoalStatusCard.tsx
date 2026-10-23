'use client';

import { useEffect, useState } from 'react';
import { isLiveSessionGoal } from '@/lib/bot-goals';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';

interface GoalWire {
  goalId: string;
  source?: string;
  status: string;
  closeReason?: string;
  condition: string;
  turnsUsed: number;
  maxTurns: number;
  missing?: string[];
  spec?: { verify?: { kind: string; paths?: string[]; url?: string } };
}

const GOAL_STATUS_KEY: Record<string, MessageKey> = {
  queued: 'goals.status.queued', running: 'goals.status.running', waiting: 'goals.status.waiting', blocked: 'goals.status.blocked', paused: 'goals.status.paused',
  deriving: 'play.goalCard.statusDeriving',
  active: 'play.goalCard.statusActive',
  waiting_user: 'play.goalCard.statusWaiting',
  achieved: 'play.goalCard.statusAchieved',
  unmet_closed: 'play.goalCard.statusUnmet'
};

export function GoalStatusCard({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [goal, setGoal] = useState<GoalWire | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setGoal(null);
    setLoadError(false);
    if (!sessionId) return;

    const pull = async () => {
      try {
        const data = (await api(`/api/sessions/${encodeURIComponent(sessionId)}/goal`)) as {
          goal: GoalWire | null;
        };
        if (cancelled) return;
        setGoal(data.goal);
        setLoadError(false);
      } catch {
        if (cancelled) return;
        setLoadError(true);
      }
    };

    void pull();
    const timer = setInterval(() => void pull(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  if (!sessionId) return null;
  if (!goal) {
    if (!loadError) return null;
    return (
      <div className="goal-status-card" role="alert">
        {t('play.goalCard.loadFailed')}
      </div>
    );
  }

  if (!isLiveSessionGoal(goal.status)) return null;

  const tone = goal.status === 'achieved' ? 'is-ok' : goal.status === 'unmet_closed' ? 'is-warn' : '';
  const statusKey = GOAL_STATUS_KEY[goal.status];

  return (
    <div className={`goal-status-card ${tone}`} role="status">
      {loadError ? <div role="alert">{t('play.goalCard.loadFailed')}</div> : null}
      <span className="goal-status-card__label">{t('play.goalCard.title')}</span>
      <strong>{statusKey ? t(statusKey) : goal.status}</strong>
      {goal.closeReason ? <span className="muted"> · {goal.closeReason}</span> : null}
      <span className="muted">
        {' '}
        · {goal.source === 'bot' ? t('goals.attemptUsage', { used: goal.turnsUsed, max: goal.maxTurns }) : `${goal.turnsUsed}/${goal.maxTurns}`}
      </span>
      {goal.source === 'bot' ? <span className="muted">{t('goals.durableVerification')}</span> : goal.spec?.verify?.kind ? (
        <span className="muted">{t('play.goalCard.verify', { kind: goal.spec.verify.kind })}</span>
      ) : (
        <span className="muted">{t('play.goalCard.softGate')}</span>
      )}
      {goal.condition ? (
        <div className="goal-status-card__cond" title={goal.condition}>
          {goal.condition}
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { RoomGoalView } from './room-console';

export function RoomGoalBar({
  goal,
  busy,
  onPause,
  onCancel,
  onAmend
}: {
  goal: RoomGoalView | null;
  busy: boolean;
  onPause: () => void;
  onCancel: () => void;
  onAmend: (constraint: string) => void;
}) {
  const { t } = useI18n();
  const [constraint, setConstraint] = useState('');
  if (!goal) return null;
  return (
    <section className="play-group-goal" data-testid="play-group-goal" aria-label={t('play.roomGoal.title')}>
      <p className="play-group-goal__title">{goal.title}</p>
      {goal.wave ? <p data-testid="play-group-goal-wave">{t('play.roomGoal.wave', { wave: goal.wave })}</p> : null}
      {goal.progress ? <p>{t('play.roomGoal.progress', { progress: goal.progress })}</p> : null}
      {goal.canControl ? (
        <div className="play-group-goal__actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onPause}>{t('play.roomGoal.pause')}</button>
          <label>
            {t('play.roomGoal.constraint')}
            <input
              aria-label={t('play.roomGoal.constraint')}
              placeholder={t('play.roomGoal.constraintPlaceholder')}
              value={constraint}
              disabled={busy}
              onChange={(event) => setConstraint(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !constraint.trim()}
            onClick={() => {
              const next = constraint.trim();
              if (!next) return;
              setConstraint('');
              onAmend(next);
            }}
          >
            {t('play.roomGoal.applyConstraint')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>{t('play.roomGoal.cancel')}</button>
        </div>
      ) : null}
    </section>
  );
}

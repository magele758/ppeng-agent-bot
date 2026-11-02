'use client';
import { useEffect, useState } from 'react';
import './goal-history.css';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';

type HistoryGoal = { updatedAt?: string; id?: string; goalId?: string; title?: string; condition?: string; status: string; progress?: string; blockedReason?: string; closeReason?: string; evidence?: string[] };
const labels: Record<string, MessageKey> = {
  pending_review: 'goals.status.pending_review', completed: 'goals.status.completed', failed: 'goals.status.failed', cancelled: 'goals.status.cancelled',
  achieved: 'play.goalCard.statusAchieved', unmet_closed: 'play.goalCard.statusUnmet'
};
export function GoalHistory({ sessionId, botId }: { sessionId: string | null; botId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [goals, setGoals] = useState<HistoryGoal[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || !sessionId) return;
    const controller = new AbortController();
    const url = `/api/goals?sessionId=${encodeURIComponent(sessionId)}`;
    setGoals(null); setFailed(false);
    const load = async () => {
      try {
        const value = await api(url, { signal: controller.signal }) as { goals: HistoryGoal[] };
        if (!controller.signal.aborted) {
          setGoals((value.goals ?? []).filter(goal => Object.hasOwn(labels, goal.status)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
          setFailed(false);
        }
      } catch { if (!controller.signal.aborted) setFailed(true); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [open, sessionId, botId]);
  if (!sessionId) return null;
  return <details className="goal-history" data-testid="goal-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('goals.history')}</summary>
    {open && <div className="goal-history__body">
      {failed ? <p role="alert">{t('goals.historyError')}</p> : !goals ? <p>{t('goals.loading')}</p> : goals.length === 0 ? <p>{t('goals.historyEmpty')}</p> : goals.map(goal => <article key={goal.id ?? goal.goalId}>
        <strong>{goal.title ?? goal.condition}</strong> · <span>{t(labels[goal.status])}</span>
        {goal.progress && <p>{goal.progress}</p>}
        {historyReason(goal) && <p>{historyReason(goal)}</p>}
        {!!goal.evidence?.length && <ul>{goal.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
      </article>)}
    </div>}
  </details>;
}

function historyReason(goal: HistoryGoal): string | undefined {
  return goal.status === 'pending_review' ? undefined : goal.blockedReason || goal.closeReason;
}

'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { getScheduleActions, type ScheduleAction } from '@/lib/task-queue-view';
import type { SocialPostScheduleItem } from '@/lib/types';
import { SCHEDULE_ACTION_META } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

const ACTION_BTN_CLASS: Readonly<Record<'primary' | 'danger' | 'neutral', string>> = {
  primary: `${styles.pillBtn} ${styles.pillBtnPrimary}`,
  danger: `${styles.pillBtn} ${styles.pillBtnDanger}`,
  neutral: styles.pillBtn
};

function ScheduleFeedbackBanner({ feedback }: { feedback: { kind: 'ok' | 'error'; text: string } | null }) {
  if (!feedback) return null;
  if (feedback.kind === 'error') {
    return <p role="alert">{feedback.text}</p>;
  }
  return <p className={styles.feedbackOk}>{feedback.text}</p>;
}

function ScheduleActionButton({
  action,
  busy,
  onRun
}: {
  action: ScheduleAction;
  busy: boolean;
  onRun: (action: ScheduleAction) => void;
}) {
  const { t } = useI18n();
  const meta = SCHEDULE_ACTION_META[action];
  return (
    <button
      type="button"
      className={ACTION_BTN_CLASS[meta.tone]}
      disabled={busy}
      data-testid={`schedule-action-${action}`}
      onClick={() => onRun(action)}
    >
      {t(meta.labelKey)}
    </button>
  );
}

export function TaskQueueScheduleDetail({
  schedule,
  onOpenSession,
  onRefresh
}: {
  schedule: SocialPostScheduleItem;
  onOpenSession: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const actions = getScheduleActions(schedule.status);

  const runAction = async (action: ScheduleAction) => {
    setBusy(true);
    setFeedback(null);
    try {
      await api(`/api/social-post-schedules/${encodeURIComponent(schedule.taskId)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      setFeedback({ kind: 'ok', text: t('tasks.queue.actionSuccess') });
      await onRefresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFeedback({ kind: 'error', text: t('tasks.actionFailed', { error: msg }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={styles.detailBody}>
        <div className={styles.metaStrip}>
          <span className={styles.monoTag}>{schedule.taskId}</span>
          {schedule.approval ? <span className={styles.chip}>{schedule.approval}</span> : null}
          {schedule.dispatchState ? <span className={styles.chip}>{schedule.dispatchState}</span> : null}
        </div>
        <ScheduleFeedbackBanner feedback={feedback} />
        <section className={styles.detailSection}>
          <h4 className={styles.sectionHeading}>{t('tasks.queue.scheduleMeta')}</h4>
          <div className={styles.metaGrid}>
            <div className={styles.metaField}>
              <span className={styles.metaLabel}>{t('tasks.queue.publishAtLabel')}</span>
              <span className={styles.metaValue}>{schedule.publishAt}</span>
            </div>
            <div className={styles.metaField}>
              <span className={styles.metaLabel}>{t('tasks.queue.channelsLabel')}</span>
              <div className={styles.chipList}>
                {schedule.channels.map((ch) => (
                  <span key={ch} className={styles.chip}>
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
      <footer className={styles.detailFooter}>
        <div className={styles.footerActions}>
          {actions.map((action) => (
            <ScheduleActionButton key={action} action={action} busy={busy} onRun={(a) => void runAction(a)} />
          ))}
        </div>
        <div className={styles.footerActions}>
          {schedule.sessionId ? (
            <button
              type="button"
              className={styles.pillBtn}
              onClick={() => onOpenSession(schedule.sessionId as string)}
            >
              {t('tasks.openSession')}
            </button>
          ) : null}
        </div>
      </footer>
    </>
  );
}

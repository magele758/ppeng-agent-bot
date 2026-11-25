'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getBotInitials } from '@/lib/bot-tasks-view';
import { useI18n } from '@/lib/i18n';
import {
  formatQueueEventSummary,
  resolveAgentLabel,
  type TaskDetailPayload,
  type TaskEventRecord
} from '@/lib/task-queue-view';
import type { BotInfo, TaskSummary } from '@/lib/types';
import { formatIsoTimestamp } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

interface DetailFetchState {
  taskId: string | undefined;
  payload: TaskDetailPayload | null;
  loading: boolean;
  error: boolean;
}

function useTaskDetailFetch(taskId: string | undefined): DetailFetchState {
  const [state, setState] = useState<DetailFetchState>({
    taskId: undefined,
    payload: null,
    loading: false,
    error: false
  });

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    setState({ taskId, payload: null, loading: true, error: false });
    void api(`/api/tasks/${encodeURIComponent(taskId)}`).then(
      (data) => {
        if (!cancelled) {
          setState({ taskId, payload: data as TaskDetailPayload, loading: false, error: false });
        }
      },
      () => {
        if (!cancelled) {
          setState({ taskId, payload: null, loading: false, error: true });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (!taskId || state.taskId !== taskId) {
    return { taskId, payload: null, loading: Boolean(taskId), error: false };
  }
  return state;
}

function formatPayloadJson(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return '';
  return JSON.stringify(payload, null, 2);
}

function FoldedEventRow({ event }: { event: TaskEventRecord }) {
  const { locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = formatQueueEventSummary(event, locale);
  const payloadJson = formatPayloadJson(event.payload);

  return (
    <div className={styles.foldedEvent} data-testid="queue-event-folded">
      <button
        type="button"
        className={styles.foldedTrigger}
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className={styles.eventTitle}>{summary.title}</span>
        <span className={styles.eventSnippet}>{summary.detail}</span>
        {summary.time ? <span className={styles.eventTime}>{summary.time}</span> : null}
      </button>
      {expanded ? (
        <div className={styles.foldedExpandedBody}>
          <div>{formatIsoTimestamp(event.createdAt, locale)}</div>
          {summary.detail ? <p className={styles.latestEventDetail}>{summary.detail}</p> : null}
          {payloadJson ? <pre className={styles.codeBlock}>{payloadJson}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function LatestEventCard({ event }: { event: TaskEventRecord }) {
  const { locale } = useI18n();
  const summary = formatQueueEventSummary(event, locale);
  const payloadJson = formatPayloadJson(event.payload);

  return (
    <div className={styles.latestEventCard} data-testid="queue-event-latest">
      <div className={styles.latestEventHead}>
        <span className={styles.eventTitle}>{summary.title}</span>
        <span className={styles.eventTime}>{summary.time || formatIsoTimestamp(event.createdAt, locale)}</span>
      </div>
      {summary.detail ? <p className={styles.latestEventDetail}>{summary.detail}</p> : null}
      {payloadJson ? <pre className={styles.codeBlock}>{payloadJson}</pre> : null}
    </div>
  );
}

function sliceEarlierEvents(
  earlier: readonly TaskEventRecord[],
  showAll: boolean
): { head: readonly TaskEventRecord[]; hiddenCount: number; tail: readonly TaskEventRecord[] } {
  if (showAll || earlier.length <= 3) {
    return { head: earlier, hiddenCount: 0, tail: [] };
  }
  return {
    head: earlier.slice(0, 1),
    hiddenCount: earlier.length - 3,
    tail: earlier.slice(-2)
  };
}

function TaskTimelineSection({ events }: { events: readonly TaskEventRecord[] }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);

  if (events.length === 0) {
    return (
      <section className={styles.detailSection}>
        <h4 className={styles.sectionHeading}>{t('tasks.queue.timelineHeading')}</h4>
        <p className={styles.mutedNote}>{t('tasks.queue.timelineEmpty')}</p>
      </section>
    );
  }

  const latest = events[events.length - 1];
  const earlier = events.slice(0, -1);
  const { head, hiddenCount, tail } = sliceEarlierEvents(earlier, showAll);

  return (
    <section className={styles.detailSection}>
      <h4 className={styles.sectionHeading}>{t('tasks.queue.timelineHeading')}</h4>
      <div className={styles.timeline}>
        {head.map((ev) => (
          <FoldedEventRow key={ev.id} event={ev} />
        ))}
        {hiddenCount > 0 ? (
          <div className={styles.showMoreWrap}>
            <button type="button" className={styles.showMoreBtn} onClick={() => setShowAll(true)}>
              {t('tasks.queue.timelineShowAll', { count: hiddenCount })}
            </button>
          </div>
        ) : null}
        {tail.map((ev) => (
          <FoldedEventRow key={ev.id} event={ev} />
        ))}
        <LatestEventCard event={latest} />
      </div>
    </section>
  );
}

function TaskMetaStrip({ task, bots }: { task: TaskSummary; bots: readonly BotInfo[] }) {
  const { t, locale } = useI18n();
  const agentLabel = resolveAgentLabel(task.ownerAgentId, bots, t('tasks.queue.unassigned'));
  const created = formatIsoTimestamp(task.createdAt, locale);
  const updated = formatIsoTimestamp(task.updatedAt, locale);

  return (
    <div className={styles.metaStrip}>
      <span className={styles.metaItem}>
        <span className={styles.avatar} aria-hidden="true">
          {getBotInitials(agentLabel)}
        </span>
        <span>{agentLabel}</span>
      </span>
      {created ? <span>{t('botWork.createdAt', { time: created })}</span> : null}
      {updated ? <span>{t('botWork.updatedAt', { time: updated })}</span> : null}
      {task.id ? <span className={styles.monoTag}>{task.id}</span> : null}
    </div>
  );
}

function TaskBlockedBySection({ blockedBy }: { blockedBy: readonly string[] | undefined }) {
  const { t } = useI18n();
  if (!blockedBy || blockedBy.length === 0) return null;

  return (
    <section className={styles.detailSection}>
      <h4 className={styles.sectionHeading}>{t('tasks.queue.blockedByHeading')}</h4>
      <div className={styles.chipList}>
        {blockedBy.map((depId) => (
          <span key={depId} className={styles.monoTag}>
            {depId}
          </span>
        ))}
      </div>
    </section>
  );
}

function TaskDetailStatusNotice({ loading, error }: { loading: boolean; error: boolean }) {
  const { t } = useI18n();
  if (error) return <p role="alert">{t('tasks.queue.detailLoadFailed')}</p>;
  if (loading) return <p className={styles.mutedNote}>{t('tasks.queue.loadingDetail')}</p>;
  return null;
}

function TaskDescriptionSection({ description }: { description: string | undefined }) {
  const { t } = useI18n();
  if (!description) return null;
  return (
    <section className={styles.detailSection}>
      <h4 className={styles.sectionHeading}>{t('tasks.queue.descriptionHeading')}</h4>
      <p className={styles.descriptionCard}>{description}</p>
    </section>
  );
}

function TaskDetailFooter({
  taskId,
  sessionId,
  onOpenSession
}: {
  taskId: string | undefined;
  sessionId: string | undefined;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <footer className={styles.detailFooter}>
      <span className={styles.mutedNote}>{taskId ? taskId : t('tasks.queue.taskTypeBadge')}</span>
      <div className={styles.footerActions}>
        {sessionId ? (
          <button
            type="button"
            className={`${styles.pillBtn} ${styles.pillBtnPrimary}`}
            onClick={() => onOpenSession(sessionId)}
          >
            {t('tasks.openSession')}
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function resolveDetailData(task: TaskSummary, payload: TaskDetailPayload | null) {
  const resolved = payload?.task ?? task;
  return {
    resolved,
    events: payload?.events ?? [],
    sessionId: resolved.sessionId ?? payload?.session?.id
  };
}

export function TaskQueueTaskDetail({
  task,
  bots,
  onOpenSession
}: {
  task: TaskSummary;
  bots: readonly BotInfo[];
  onOpenSession: (sessionId: string) => void;
}) {
  const detail = useTaskDetailFetch(task.id);
  const { resolved, events, sessionId } = resolveDetailData(task, detail.payload);

  return (
    <>
      <div className={styles.detailBody}>
        <TaskMetaStrip task={resolved} bots={bots} />
        <TaskDetailStatusNotice loading={detail.loading} error={detail.error} />
        <TaskDescriptionSection description={resolved.description} />
        <TaskBlockedBySection blockedBy={resolved.blockedBy} />
        {task.id ? <TaskTimelineSection key={task.id} events={events} /> : null}
      </div>
      <TaskDetailFooter taskId={resolved.id} sessionId={sessionId} onOpenSession={onOpenSession} />
    </>
  );
}

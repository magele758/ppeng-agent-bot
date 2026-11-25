'use client';

import { formatRelativeTime, getBotInitials } from '@/lib/bot-tasks-view';
import { useI18n } from '@/lib/i18n';
import { extractJobDisplayTitle, resolveAgentLabel } from '@/lib/task-queue-view';
import type { BotInfo, SocialPostScheduleItem, TaskSummary } from '@/lib/types';
import type { JobRow } from '../../shell/LabProvider';
import { TaskQueueStatusBadge } from './TaskQueueStatusBadge';
import { firstLineSnippet } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

function rowProps(selected: boolean, onSelect: () => void) {
  return {
    type: 'button' as const,
    className: selected ? `list-item ${styles.row} ${styles.rowSelected}` : `list-item ${styles.row}`,
    'data-selected': selected ? 'true' : 'false',
    'aria-current': selected ? ('true' as const) : undefined,
    onClick: onSelect
  };
}

function RowTimestamp({ iso }: { iso: string | undefined }) {
  const { locale } = useI18n();
  const rel = formatRelativeTime(iso, locale);
  return rel ? <span className={styles.rowTime}>{rel}</span> : null;
}

export function TaskQueueTaskRow({
  task,
  bots,
  selected,
  onSelect
}: {
  task: TaskSummary;
  bots: readonly BotInfo[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const agentLabel = resolveAgentLabel(task.ownerAgentId, bots, t('tasks.queue.unassigned'));
  const preview = firstLineSnippet(task.description);

  return (
    <button {...rowProps(selected, onSelect)}>
      <span className={styles.rowLine1}>
        <span className={styles.rowActor}>
          <span className={styles.avatar} aria-hidden="true">
            {getBotInitials(agentLabel)}
          </span>
          <span className={styles.actorName}>{agentLabel}</span>
        </span>
        <RowTimestamp iso={task.updatedAt ?? task.createdAt} />
      </span>
      <span className={styles.rowTitle}>{task.title}</span>
      <span className={styles.rowLine3}>
        <span className={styles.rowPreview}>{preview}</span>
        <TaskQueueStatusBadge status={task.status} />
      </span>
    </button>
  );
}

export function TaskQueueScheduleRow({
  schedule,
  selected,
  onSelect
}: {
  schedule: SocialPostScheduleItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const channelText = schedule.channels.join(' · ') || t('tasks.queue.scheduleTypeBadge');

  return (
    <button {...rowProps(selected, onSelect)}>
      <span className={styles.rowLine1}>
        <span className={styles.rowActor}>
          <span className={styles.avatar} aria-hidden="true">
            {getBotInitials(channelText)}
          </span>
          <span className={styles.actorName}>{channelText}</span>
        </span>
        <RowTimestamp iso={schedule.publishAt} />
      </span>
      <span className={styles.rowTitle}>{schedule.title}</span>
      <span className={styles.rowLine3}>
        <span className={styles.rowPreview}>{schedule.publishAt}</span>
        <TaskQueueStatusBadge status={schedule.status} />
      </span>
    </button>
  );
}

export function TaskQueueJobRow({
  job,
  selected,
  onSelect
}: {
  job: JobRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const displayTitle = extractJobDisplayTitle(job.command, t('tasks.queue.unnamedJob'));
  const preview = firstLineSnippet(job.result) || t('tasks.queue.noOutput');

  return (
    <button {...rowProps(selected, onSelect)}>
      <span className={styles.rowLine1}>
        <span className={styles.rowActor}>
          <span className={`${styles.avatar} ${styles.avatarMono}`} aria-hidden="true">
            $_
          </span>
          <span className={styles.actorName}>{t('tasks.queue.jobTypeBadge')}</span>
        </span>
        <RowTimestamp iso={job.updatedAt ?? job.createdAt} />
      </span>
      <span className={styles.rowTitle}>{displayTitle}</span>
      <span className={styles.rowLine3}>
        <span className={styles.rowPreview}>{preview}</span>
        <TaskQueueStatusBadge status={job.status} />
      </span>
    </button>
  );
}

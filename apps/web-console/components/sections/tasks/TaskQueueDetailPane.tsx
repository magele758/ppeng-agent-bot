'use client';

import { useI18n } from '@/lib/i18n';
import { extractJobDisplayTitle } from '@/lib/task-queue-view';
import type { BotInfo } from '@/lib/types';
import { TaskQueueJobDetail } from './TaskQueueJobDetail';
import { TaskQueueScheduleDetail } from './TaskQueueScheduleDetail';
import { TaskQueueStatusBadge } from './TaskQueueStatusBadge';
import { TaskQueueTaskDetail } from './TaskQueueTaskDetail';
import type { ResolvedQueueItem } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

function headerMetaOf(
  item: ResolvedQueueItem,
  t: ReturnType<typeof useI18n>['t']
): { badge: string; title: string; status: string | undefined } {
  if (item.kind === 'task') {
    return { badge: t('tasks.queue.taskTypeBadge'), title: item.task.title, status: item.task.status };
  }
  if (item.kind === 'schedule') {
    return { badge: t('tasks.queue.scheduleTypeBadge'), title: item.schedule.title, status: item.schedule.status };
  }
  return {
    badge: t('tasks.queue.jobTypeBadge'),
    title: extractJobDisplayTitle(item.job.command, t('tasks.queue.unnamedJob')),
    status: item.job.status
  };
}

function DetailBody({
  item,
  bots,
  onOpenSession,
  onRefresh
}: {
  item: ResolvedQueueItem;
  bots: readonly BotInfo[];
  onOpenSession: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}) {
  if (item.kind === 'task') {
    return <TaskQueueTaskDetail key={item.key} task={item.task} bots={bots} onOpenSession={onOpenSession} />;
  }
  if (item.kind === 'schedule') {
    return (
      <TaskQueueScheduleDetail
        key={item.key}
        schedule={item.schedule}
        onOpenSession={onOpenSession}
        onRefresh={onRefresh}
      />
    );
  }
  return <TaskQueueJobDetail key={item.key} job={item.job} onOpenSession={onOpenSession} />;
}

export interface TaskQueueDetailPaneProps {
  item: ResolvedQueueItem | null;
  bots: readonly BotInfo[];
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}

export function TaskQueueDetailPane({
  item,
  bots,
  hasPrev,
  hasNext,
  onStep,
  onClose,
  onOpenSession,
  onRefresh
}: TaskQueueDetailPaneProps) {
  const { t } = useI18n();

  if (!item) {
    return (
      <aside className={styles.detailPane} data-testid="task-queue-detail-pane">
        <div className={styles.detailEmpty}>
          <h3 className={styles.detailEmptyTitle}>{t('tasks.queue.selectItemPrompt')}</h3>
          <p className={styles.detailEmptyHint}>{t('tasks.queue.selectItemHint')}</p>
        </div>
      </aside>
    );
  }

  const head = headerMetaOf(item, t);

  return (
    <aside className={styles.detailPane} data-testid="task-queue-detail-pane">
      <header className={styles.detailHeader}>
        <div className={styles.detailHeaderMain}>
          <span className={styles.typeChip}>{head.badge}</span>
          <h3 className={styles.detailTitle} title={head.title}>
            {head.title}
          </h3>
          <TaskQueueStatusBadge status={head.status} />
        </div>
        <div className={styles.detailNav}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('tasks.queue.prevItem')}
            title={t('tasks.queue.prevItem')}
            disabled={!hasPrev}
            onClick={() => onStep(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('tasks.queue.nextItem')}
            title={t('tasks.queue.nextItem')}
            disabled={!hasNext}
            onClick={() => onStep(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('tasks.queue.closeDetail')}
            title={t('tasks.queue.closeDetail')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      <DetailBody item={item} bots={bots} onOpenSession={onOpenSession} onRefresh={onRefresh} />
    </aside>
  );
}

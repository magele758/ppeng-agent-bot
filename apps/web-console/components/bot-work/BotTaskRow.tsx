'use client';

import { useI18n } from '@/lib/i18n';
import {
  extractBotTaskPreview,
  extractBotTaskTitle,
  formatRelativeTime,
  getBotInitials,
  type BotTaskItem,
} from '@/lib/bot-tasks-view';
import { Status } from './shared';
import styles from './bot-team-work.module.css';

const CANCELLABLE_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

export function isCancellableTaskStatus(status: string): boolean {
  return CANCELLABLE_STATUSES.has(status);
}

interface BotTaskRowProps {
  task: BotTaskItem;
  botName: string;
  selected: boolean;
  busy: boolean;
  onSelect: (task: BotTaskItem) => void;
  onCancel: (taskId: string) => void;
}

function TaskRowActions({
  task,
  selected,
  busy,
  onSelect,
  onCancel,
}: {
  task: BotTaskItem;
  selected: boolean;
  busy: boolean;
  onSelect: (task: BotTaskItem) => void;
  onCancel: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const showRowCancel = isCancellableTaskStatus(task.status) && !selected;
  return (
    <span className={styles.rowActions}>
      <Status value={task.status} />
      <button
        type="button"
        className={styles.rowActionBtn}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(task);
        }}
      >
        {t('botWork.details')}
      </button>
      {showRowCancel && (
        <button
          type="button"
          className={`${styles.rowActionBtn} ${styles.rowActionDanger}`}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onCancel(task.id);
          }}
        >
          {t('botWork.cancel')}
        </button>
      )}
    </span>
  );
}

export function BotTaskRow({
  task,
  botName,
  selected,
  busy,
  onSelect,
  onCancel,
}: BotTaskRowProps) {
  const { locale } = useI18n();
  const { title } = extractBotTaskTitle(task.input, task.id);
  const preview = extractBotTaskPreview(task, title);
  const relTime = formatRelativeTime(task.updatedAt ?? task.createdAt, locale);
  const rowClass = selected ? `${styles.taskRow} ${styles.taskRowSelected}` : styles.taskRow;

  return (
    <article
      className={rowClass}
      data-selected={selected ? 'true' : 'false'}
      onClick={() => onSelect(task)}
    >
      <span className={styles.srOnly}>
        {botName}: {task.input}
      </span>

      <div className={styles.rowL1}>
        <span className={styles.botBadge}>
          <span className={styles.avatar} aria-hidden="true">
            {getBotInitials(botName)}
          </span>
          <span className={styles.botName}>{botName}</span>
        </span>
        {relTime && <span className={styles.rowTime}>{relTime}</span>}
      </div>

      <p className={styles.rowTitle}>{title}</p>

      <div className={styles.rowL3}>
        <span className={styles.rowPreview}>{preview}</span>
        <TaskRowActions
          task={task}
          selected={selected}
          busy={busy}
          onSelect={onSelect}
          onCancel={onCancel}
        />
      </div>
    </article>
  );
}

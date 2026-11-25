'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  extractBotTaskTitle,
  extractCollaborationTitle,
  formatRelativeTime,
  getBotInitials,
  relativeTimeLabelsFrom,
  type BotCollaborationGroup,
  type BotTaskDetail,
  type BotTaskItem,
} from '@/lib/bot-tasks-view';
import { botConnectionsHref } from '@/lib/bot-recovery-link';
import { Result, Status } from './shared';
import { TaskDelivery } from './TaskDelivery';
import { BotCronPanel } from '../BotCronPanel';
import { isCancellableTaskStatus } from './BotTaskRow';
import styles from './bot-team-work.module.css';

const RETRIABLE_STATUSES = new Set(['failed', 'cancelled', 'unknown']);

interface BotTaskDetailPaneProps {
  selected: BotTaskDetail | null;
  selectedCollab: BotCollaborationGroup | null;
  routineTask: BotTaskDetail | null;
  botNameMap: ReadonlyMap<string, string>;
  busy: boolean;
  confirmUnknown: boolean;
  prevTaskId: string | null;
  nextTaskId: string | null;
  onConfirmUnknownChange: (checked: boolean) => void;
  onStepTask: (taskId: string) => void;
  onCloseDetail: () => void;
  onContinueInChat: (botId: string) => void;
  onSaveAsRoutine: (task: BotTaskDetail) => void;
  onCloseRoutine: () => void;
  onOpenSourceVersion: (source: { taskId: string; attempt: number }) => void;
  onSelectDeliveryAttempt: (attempt: number) => void;
  onContinueFromDelivery: (task: BotTaskDetail) => void;
  onRetry: () => void;
  onCancel: (taskId: string) => void;
  onSelectMemberTask: (task: BotTaskItem) => void;
}

function canSaveAsRoutine(task: BotTaskDetail): boolean {
  return task.status === 'completed' && task.delivery?.executionStatus === 'completed';
}

function collapseOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function VersionPills({
  task,
  onSelectDeliveryAttempt,
}: {
  task: BotTaskDetail;
  onSelectDeliveryAttempt: (attempt: number) => void;
}) {
  const { t } = useI18n();
  const versions = task.deliveryVersions ?? [];
  if (versions.length <= 1) return null;
  return (
    <>
      <span className={styles.versionLabel}>{t('botWork.versionsHeading')}</span>
      {versions.map((version) => {
        const active = task.delivery?.attempt === version.attempt;
        const cls = active ? `${styles.filterPill} ${styles.filterPillActive}` : styles.filterPill;
        return (
          <button
            key={version.attempt}
            type="button"
            className={cls}
            aria-pressed={active}
            onClick={() => onSelectDeliveryAttempt(version.attempt)}
          >
            {t('botWork.deliveryAttempt', { attempt: version.attempt })}
          </button>
        );
      })}
    </>
  );
}

function DeliveryVersionBar({
  task,
  busy,
  onOpenSourceVersion,
  onSelectDeliveryAttempt,
}: {
  task: BotTaskDetail;
  busy: boolean;
  onOpenSourceVersion: (source: { taskId: string; attempt: number }) => void;
  onSelectDeliveryAttempt: (attempt: number) => void;
}) {
  const { t } = useI18n();
  const hasMultiple = (task.deliveryVersions?.length ?? 0) > 1;
  if (!hasMultiple && !task.sourceDelivery) return null;

  return (
    <div className={styles.versionBar}>
      <VersionPills task={task} onSelectDeliveryAttempt={onSelectDeliveryAttempt} />
      {task.sourceDelivery && (
        <button
          type="button"
          className={styles.ghostBtn}
          disabled={busy}
          onClick={() => onOpenSourceVersion(task.sourceDelivery!)}
        >
          {t('botWork.viewSourceVersion')}
        </button>
      )}
    </div>
  );
}

function FoldedRawPrompt({ input }: { input: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const singleLine = collapseOneLine(input);
  return (
    <details
      className={styles.foldedRow}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.foldedSummary}>
        <span className={styles.foldedTitle}>{t('botWork.rawPromptTitle')}</span>
        <span className={styles.foldedPreview}>{singleLine}</span>
        <span className={styles.foldedHint}>
          {t(open ? 'botWork.rawPromptCollapse' : 'botWork.rawPromptExpand')}
        </span>
      </summary>
      <pre className={styles.rawPromptBody}>{input}</pre>
    </details>
  );
}

function topOnlyFailureReason(task: BotTaskDetail): string {
  const reason = task.failureReason?.trim() ?? '';
  if (!reason) return '';
  return task.delivery?.failureReason?.trim() === reason ? '' : reason;
}

function TaskFailureBanner({ reason }: { reason: string }) {
  const { t } = useI18n();
  if (!reason) return null;
  return (
    <p role="alert" className={styles.failureBanner}>
      {t('botWork.unfinishedReason', { reason })}
    </p>
  );
}

function FooterNotices({
  status,
  confirmUnknown,
  onConfirmUnknownChange,
}: {
  status: string;
  confirmUnknown: boolean;
  onConfirmUnknownChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {status === 'cancelled' && (
        <p className={styles.footerNote}>{t('botWork.cancelEffectNote')}</p>
      )}
      {status === 'unknown' && (
        <label className={styles.footerConfirm}>
          <input
            type="checkbox"
            checked={confirmUnknown}
            onChange={(event) => onConfirmUnknownChange(event.target.checked)}
          />
          <span>{t('botWork.confirmUnknown')}</span>
        </label>
      )}
    </>
  );
}

function isRetryDisabled(status: string, busy: boolean, confirmUnknown: boolean): boolean {
  return busy || (status === 'unknown' && !confirmUnknown);
}

function DetailFooterBar({
  task,
  busy,
  confirmUnknown,
  onConfirmUnknownChange,
  onContinueInChat,
  onRetry,
  onCancel,
}: {
  task: BotTaskDetail;
  busy: boolean;
  confirmUnknown: boolean;
  onConfirmUnknownChange: (checked: boolean) => void;
  onContinueInChat: (botId: string) => void;
  onRetry: () => void;
  onCancel: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const retriable = RETRIABLE_STATUSES.has(task.status);
  const cancellable = isCancellableTaskStatus(task.status);

  return (
    <footer className={styles.detailFooter}>
      <FooterNotices
        status={task.status}
        confirmUnknown={confirmUnknown}
        onConfirmUnknownChange={onConfirmUnknownChange}
      />
      <div className={styles.footerButtons}>
        <button
          type="button"
          className={styles.pillBtn}
          onClick={() => onContinueInChat(task.targetBotId)}
        >
          {t('botWork.continueInChat')}
        </button>
        {retriable && (
          <button
            type="button"
            className={`${styles.pillBtn} ${styles.pillBtnPrimary}`}
            disabled={isRetryDisabled(task.status, busy, confirmUnknown)}
            onClick={onRetry}
          >
            {t('botWork.retry')}
          </button>
        )}
        {cancellable && (
          <button
            type="button"
            className={`${styles.pillBtn} ${styles.pillBtnDanger}`}
            disabled={busy}
            onClick={() => onCancel(task.id)}
          >
            {t('botWork.cancel')}
          </button>
        )}
      </div>
    </footer>
  );
}

function CollaborationInspector({
  group,
  botNameMap,
  onClose,
  onSelectMember,
}: {
  group: BotCollaborationGroup;
  botNameMap: ReadonlyMap<string, string>;
  onClose: () => void;
  onSelectMember: (task: BotTaskItem) => void;
}) {
  const { t } = useI18n();
  const title = extractCollaborationTitle(group.goal, group.id);

  return (
    <aside className={styles.detailPane}>
      <p className={styles.detailStatusStrip}>
        {group.status === 'blocked' ? (
          <span className={styles.blockedPill}>{t('botWork.collaborationBlocked')}</span>
        ) : (
          <Status value={group.status} />
        )}
        <span>
          {t('botWork.collaborationProgress', {
            completed: group.completed,
            total: group.total,
          })}
        </span>
      </p>

      <div className={styles.detailHeader}>
        <h4 className={styles.detailTitle}>{title}</h4>
        <div className={styles.detailHeaderTools}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label={t('botWork.closeDetail')}
            title={t('botWork.closeDetail')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      <div className={styles.detailBody}>
        <FoldedRawPrompt key={group.id} input={group.goal} />

        {group.blockers.length > 0 && (
          <div className={styles.collabDetailSection}>
            <h5 className={styles.collabDetailHeading}>{t('botWork.collaborationBlocked')}</h5>
            {group.blockers.map((blocker) => (
              <div key={blocker.id} className={styles.collabDetailCard}>
                <strong>{botNameMap.get(blocker.targetBotId) ?? blocker.targetBotId}</strong>
                <span>{blocker.failureReason}</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.collabDetailSection}>
          <h5 className={styles.collabDetailHeading}>{t('botWork.collaborationDelivery')}</h5>
          {group.deliveries.map((task) => (
            <div key={task.id} className={styles.collabDetailCard}>
              <strong>{extractBotTaskTitle(task.input, task.id).title}</strong>
              <Result value={task.delivery?.report ?? task.result ?? task.failureReason} />
            </div>
          ))}
        </div>

        <div className={styles.collabDetailSection}>
          <h5 className={styles.collabDetailHeading}>{t('botWork.membersHeading')}</h5>
          {group.members.map((member) => (
            <div key={member.id} className={styles.collabMemberRow}>
              <span className={styles.collabMemberInfo}>
                <strong className={styles.botName}>
                  {botNameMap.get(member.targetBotId) ?? member.targetBotId}
                </strong>
                <span className={styles.collabMemberTitle}>
                  {extractBotTaskTitle(member.input, member.id).title}
                </span>
              </span>
              <span className={styles.rowActions}>
                <Status value={member.status} />
                <button
                  type="button"
                  className={styles.rowActionBtn}
                  onClick={() => onSelectMember(member)}
                >
                  {t('botWork.open')}
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function DetailStatusStrip({
  task,
  botName,
}: {
  task: BotTaskDetail;
  botName: string;
}) {
  const { t, locale } = useI18n();
  const relTime = formatRelativeTime(
    task.updatedAt ?? task.createdAt,
    locale,
    undefined,
    relativeTimeLabelsFrom(t),
  );
  const attempt = task.delivery?.attempt ?? task.attempt;
  return (
    <p className={styles.detailStatusStrip}>
      <Status value={task.status} />
      <span className={styles.detailStatusMeta}>
        <span className={styles.avatar} aria-hidden="true">
          {getBotInitials(botName)}
        </span>
        <span>{botName}</span>
      </span>
      {attempt !== undefined && (
        <>
          <span className={styles.detailMetaDot}>·</span>
          <span>{t('botWork.attemptBadge', { attempt })}</span>
        </>
      )}
      {relTime && (
        <>
          <span className={styles.detailMetaDot}>·</span>
          <span>{t('botWork.updatedAt', { time: relTime })}</span>
        </>
      )}
    </p>
  );
}

function DetailHeaderBar({
  task,
  title,
  prevTaskId,
  nextTaskId,
  onSaveAsRoutine,
  onStepTask,
  onCloseDetail,
}: {
  task: BotTaskDetail;
  title: string;
  prevTaskId: string | null;
  nextTaskId: string | null;
  onSaveAsRoutine: (task: BotTaskDetail) => void;
  onStepTask: (taskId: string) => void;
  onCloseDetail: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.detailHeader}>
      <h4 className={styles.detailTitle} title={title}>
        {title}
      </h4>
      <div className={styles.detailHeaderTools}>
        <a className={styles.ghostBtn} href={botConnectionsHref(task.targetBotId)}>
          {t('botWork.repairConnection')}
        </a>
        {canSaveAsRoutine(task) && (
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => onSaveAsRoutine(task)}
          >
            {t('botWork.saveAsRoutine')}
          </button>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          disabled={!prevTaskId}
          aria-label={t('botWork.prevItem')}
          title={t('botWork.prevItem')}
          onClick={() => prevTaskId && onStepTask(prevTaskId)}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          disabled={!nextTaskId}
          aria-label={t('botWork.nextItem')}
          title={t('botWork.nextItem')}
          onClick={() => nextTaskId && onStepTask(nextTaskId)}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('botWork.closeDetail')}
          title={t('botWork.closeDetail')}
          onClick={onCloseDetail}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function RoutineCreatorBox({
  routineTask,
  onClose,
}: {
  routineTask: BotTaskDetail | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!routineTask || !routineTask.delivery) return null;
  return (
    <div className={styles.routineContainer}>
      <div className={styles.routineHeader}>
        <strong>{t('botWork.saveAsRoutine')}</strong>
        <button type="button" className={styles.ghostBtn} onClick={onClose}>
          {t('botWork.closeDetail')}
        </button>
      </div>
      <BotCronPanel
        key={routineTask.id}
        botId={routineTask.targetBotId}
        taskTemplate={{
          taskId: routineTask.id,
          attempt: routineTask.delivery.attempt,
          prompt: routineTask.input,
        }}
      />
    </div>
  );
}

function hasOnlyFailureReason(task: BotTaskDetail): boolean {
  return task.result == null && Boolean(task.failureReason?.trim());
}

function TaskDeliveryOrResult({
  task,
  onContinueFromDelivery,
}: {
  task: BotTaskDetail;
  onContinueFromDelivery: (task: BotTaskDetail) => void;
}) {
  if (task.delivery) {
    return (
      <TaskDelivery
        key={`${task.id}:${task.delivery.attempt}`}
        delivery={task.delivery}
        onContinue={() => onContinueFromDelivery(task)}
      />
    );
  }
  if (hasOnlyFailureReason(task)) return null;
  return (
    <div className={styles.rawResultCard}>
      <Result value={task.result ?? task} />
    </div>
  );
}

function EmptyInspector() {
  const { t } = useI18n();
  return (
    <aside className={styles.detailPane}>
      <div className={styles.emptyDetail}>
        <h4 className={styles.emptyDetailTitle}>{t('botWork.selectTaskPrompt')}</h4>
        <p className={styles.emptyDetailHint}>{t('botWork.selectTaskHint')}</p>
      </div>
    </aside>
  );
}

export function BotTaskDetailPane({
  selected,
  selectedCollab,
  routineTask,
  botNameMap,
  busy,
  confirmUnknown,
  prevTaskId,
  nextTaskId,
  onConfirmUnknownChange,
  onStepTask,
  onCloseDetail,
  onContinueInChat,
  onSaveAsRoutine,
  onCloseRoutine,
  onOpenSourceVersion,
  onSelectDeliveryAttempt,
  onContinueFromDelivery,
  onRetry,
  onCancel,
  onSelectMemberTask,
}: BotTaskDetailPaneProps) {
  if (!selected && selectedCollab) {
    return (
      <CollaborationInspector
        group={selectedCollab}
        botNameMap={botNameMap}
        onClose={onCloseDetail}
        onSelectMember={onSelectMemberTask}
      />
    );
  }
  if (!selected) return <EmptyInspector />;

  const botName = botNameMap.get(selected.targetBotId) ?? selected.targetBotId;
  const { title } = extractBotTaskTitle(selected.input, selected.id);

  return (
    <aside className={styles.detailPane}>
      {/* Direct child <p> preserves E2E `:scope > p` status contract */}
      <DetailStatusStrip task={selected} botName={botName} />
      <DetailHeaderBar
        task={selected}
        title={title}
        prevTaskId={prevTaskId}
        nextTaskId={nextTaskId}
        onSaveAsRoutine={onSaveAsRoutine}
        onStepTask={onStepTask}
        onCloseDetail={onCloseDetail}
      />
      <div className={styles.detailBody}>
        <RoutineCreatorBox routineTask={routineTask} onClose={onCloseRoutine} />
        <TaskFailureBanner reason={topOnlyFailureReason(selected)} />
        <FoldedRawPrompt key={selected.id} input={selected.input} />
        <DeliveryVersionBar
          task={selected}
          busy={busy}
          onOpenSourceVersion={onOpenSourceVersion}
          onSelectDeliveryAttempt={onSelectDeliveryAttempt}
        />
        <TaskDeliveryOrResult task={selected} onContinueFromDelivery={onContinueFromDelivery} />
      </div>
      <DetailFooterBar
        task={selected}
        busy={busy}
        confirmUnknown={confirmUnknown}
        onConfirmUnknownChange={onConfirmUnknownChange}
        onContinueInChat={onContinueInChat}
        onRetry={onRetry}
        onCancel={onCancel}
      />
    </aside>
  );
}

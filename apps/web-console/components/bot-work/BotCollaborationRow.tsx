'use client';

import { useI18n } from '@/lib/i18n';
import {
  extractBotTaskTitle,
  extractCollaborationPreview,
  extractCollaborationTitle,
  type BotCollaborationGroup,
  type BotTaskItem,
} from '@/lib/bot-tasks-view';
import { Status } from './shared';
import { isCancellableTaskStatus } from './BotTaskRow';
import styles from './bot-team-work.module.css';

interface BotCollaborationRowProps {
  group: BotCollaborationGroup;
  botNameMap: ReadonlyMap<string, string>;
  selectedCollabId: string | null;
  selectedTaskId: string | null;
  busy: boolean;
  onSelectCollaboration: (groupId: string) => void;
  onSelectTask: (task: BotTaskItem) => void;
  onCancelTask: (taskId: string) => void;
}

function resolveBotName(botNameMap: ReadonlyMap<string, string>, botId: string): string {
  return botNameMap.get(botId) ?? botId;
}

function rawDeliveryText(task: BotTaskItem): string {
  if (task.delivery?.report) return task.delivery.report;
  if (typeof task.result === 'string' && task.result) return task.result;
  return task.failureReason ?? '';
}

function firstDeliverySnippet(group: BotCollaborationGroup): string {
  if (group.summary) return extractCollaborationPreview(group.summary);
  for (const task of group.deliveries) {
    const snippet = extractCollaborationPreview(rawDeliveryText(task));
    if (snippet) return snippet;
  }
  return '';
}

function CollaborationMemberRow({
  member,
  botName,
  isSelected,
  busy,
  onSelect,
  onCancel,
}: {
  member: BotTaskItem;
  botName: string;
  isSelected: boolean;
  busy: boolean;
  onSelect: (task: BotTaskItem) => void;
  onCancel: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const { title } = extractBotTaskTitle(member.input, member.id);
  const showCancel = isCancellableTaskStatus(member.status) && !isSelected;

  return (
    <article className={styles.collabMemberRow}>
      <span className={styles.srOnly}>
        {botName}: {member.input}
      </span>
      <span className={styles.collabMemberInfo}>
        <strong className={styles.botName}>{botName}</strong>
        <span className={styles.collabMemberTitle}>{title}</span>
      </span>
      <span className={styles.rowActions}>
        <Status value={member.status} />
        <button
          type="button"
          className={styles.rowActionBtn}
          disabled={busy}
          onClick={() => onSelect(member)}
        >
          {t('botWork.details')}
        </button>
        {showCancel && (
          <button
            type="button"
            className={`${styles.rowActionBtn} ${styles.rowActionDanger}`}
            disabled={busy}
            onClick={() => onCancel(member.id)}
          >
            {t('botWork.cancel')}
          </button>
        )}
      </span>
    </article>
  );
}

export function BotCollaborationRow({
  group,
  botNameMap,
  selectedCollabId,
  selectedTaskId,
  busy,
  onSelectCollaboration,
  onSelectTask,
  onCancelTask,
}: BotCollaborationRowProps) {
  const { t } = useI18n();
  const title = extractCollaborationTitle(group.goal, group.id);
  const preview = firstDeliverySnippet(group);
  const isSelected = selectedCollabId === group.id;
  const cardClass = isSelected ? `${styles.collabCard} ${styles.collabCardSelected}` : styles.collabCard;

  return (
    <article className={cardClass} data-testid="collaboration-summary">
      <span className={styles.srOnly}>{group.goal}</span>
      <button
        type="button"
        className={styles.collabHeaderBtn}
        onClick={() => onSelectCollaboration(group.id)}
      >
        <h4 className={styles.collabTitle}>{title}</h4>
        <p className={styles.collabMeta}>
          <span>
            {t('botWork.collaborationProgress', {
              completed: group.completed,
              total: group.total,
            })}
          </span>
          <span>·</span>
          {group.status === 'blocked' ? (
            <span className={styles.blockedPill}>{t('botWork.collaborationBlocked')}</span>
          ) : (
            <Status value={group.status} />
          )}
        </p>
      </button>

      {group.blockers.map((blocker) => (
        <p key={blocker.id} className={styles.collabBlockerLine}>
          {resolveBotName(botNameMap, blocker.targetBotId)}: {blocker.failureReason}
        </p>
      ))}

      <p className={styles.collabDeliveryLine}>
        <span className={styles.collabDeliveryLabel}>{t('botWork.collaborationDelivery')}</span>
        {preview && <span className={styles.collabDeliveryPreview}>{preview}</span>}
      </p>

      <details className={styles.collabDetails}>
        <summary className={styles.collabSummary}>{t('botWork.collaborationMembers')}</summary>
        <div className={styles.collabMemberList}>
          {group.members.map((member) => (
            <CollaborationMemberRow
              key={member.id}
              member={member}
              botName={resolveBotName(botNameMap, member.targetBotId)}
              isSelected={selectedTaskId === member.id}
              busy={busy}
              onSelect={onSelectTask}
              onCancel={onCancelTask}
            />
          ))}
        </div>
      </details>
    </article>
  );
}

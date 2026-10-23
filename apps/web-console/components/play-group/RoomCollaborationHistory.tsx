'use client';

import { useI18n } from '@/lib/i18n';

export interface CollaborationTurn {
  id: string;
  collaboration?: {
    goal?: { title: string; ownerBotId?: string; status: string };
    tasks: { id: string; title: string; assigneeBotId: string; status: string; expectedEvidence?: string; summary: string; materialIds: string[] }[];
  };
}

export function RoomCollaborationHistory({ turns, names }: { turns: readonly CollaborationTurn[]; names: ReadonlyMap<string, string> }) {
  const { t } = useI18n();
  const items = turns.filter(turn => turn.collaboration?.goal);
  if (!items.length) return null;
  const statusLabel = (status: string) => {
    switch (status) {
      case 'queued': return t('play.groupSettings.taskQueued');
      case 'running': return t('play.groupSettings.taskRunning');
      case 'paused':
      case 'waiting_approval': return t('play.groupSettings.taskReview');
      case 'completed': return t('play.groupSettings.taskCompleted');
      case 'failed': return t('play.groupSettings.taskFailed');
      case 'cancelled': return t('play.groupSettings.taskCancelled');
      default: return t('play.groupSettings.taskReview');
    }
  };
  return <details data-testid="room-collaboration-history">
    <summary>{t('play.groupSettings.taskBoard')}</summary>
    {items.map(turn => <section key={turn.id}>
      <h4>{turn.collaboration!.goal!.title}</h4>
      <p>{t('play.groupSettings.taskOwner', { name: names.get(turn.collaboration!.goal!.ownerBotId ?? '') ?? turn.collaboration!.goal!.ownerBotId ?? '' })} · {statusLabel(turn.collaboration!.goal!.status)}</p>
      <ul>{turn.collaboration!.tasks.map(task => <li key={task.id}>
        <strong>{task.title}</strong> · {names.get(task.assigneeBotId) ?? task.assigneeBotId} · {statusLabel(task.status)}
        <p>{t('play.groupSettings.taskEvidence', { text: task.expectedEvidence ?? '' })}</p>
        {task.summary && <p>{task.summary}</p>}
      </li>)}</ul>
    </section>)}
  </details>;
}

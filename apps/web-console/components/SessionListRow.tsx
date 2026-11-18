'use client';

import type { CSSProperties, ReactNode } from 'react';
import { botFaceIdleDelay } from '@/lib/bot-face';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { sessionListWhen, sessionListWhenText } from '../lib/chat-page-redesign';
import { sessionActivityAt } from '../lib/session-groups';
import { rowSubtitleText, sessionRowCopy, sessionWorkBotId } from '@/lib/session-row';
import { useVisibleQuestion } from './useBotSessionQuestions';
import { BotFace } from './BotFace';
import { useBotWorkMood } from './bot-work/BotWorkState';
import { useArmedConfirm } from './use-armed-confirm';

function isCoreExecAgent(id: string): boolean {
  return id === 'general' || id === 'main';
}

function sessionListRowClass(bot: boolean, selected: boolean, checked: boolean): string {
  let name = 'list-item list-item--session';
  if (bot) name += ' list-item--bot-chat';
  if (selected) name += ' selected';
  if (checked) name += ' is-checked';
  return name;
}

type SessionCopy = ReturnType<typeof sessionRowCopy>;

function sessionRowPresentation(copy: SessionCopy, ownerText: (name: string) => string) {
  if (copy.kind === 'child-task') {
    return {
      title: copy.title,
      bot: false,
      faceName: '',
      subtitle: '',
      hasQuestion: false,
      owner: ownerText(copy.ownerName)
    };
  }
  if (copy.kind === 'bot') {
    return {
      title: copy.title,
      bot: true,
      faceName: copy.faceName,
      subtitle: copy.subtitle,
      hasQuestion: copy.hasQuestion,
      owner: ''
    };
  }
  return {
    title: copy.title,
    bot: false,
    faceName: '',
    subtitle: '',
    hasQuestion: false,
    owner: ''
  };
}

export function SessionListRow({
  session,
  bots,
  question,
  selected,
  checked,
  selectMode,
  deleting,
  status,
  showWhen = false,
  onOpen,
  onToggleChecked,
  onDelete,
  deleteAria,
  deleteLabel,
  confirmLabel, rowActions
}: {
  session: SessionSummary;
  bots: readonly BotInfo[];
  question: string;
  selected: boolean;
  checked: boolean;
  selectMode: boolean;
  deleting: boolean;
  rowActions?: ReactNode;
  status: ReactNode;
  showWhen?: boolean;
  onOpen: () => void;
  onToggleChecked: (checked: boolean) => void;
  onDelete?: (title: string) => void;
  deleteAria?: string;
  deleteLabel?: string;
  confirmLabel?: string;
}) {
  const { t } = useI18n();
  const confirm = useArmedConfirm();
  const preview = useVisibleQuestion(session, bots, question);
  const copy = sessionRowCopy({
    session,
    bots,
    question: preview.text,
    emptyHint: t('play.sidebar.noQuestion'),
    unnamed: t('play.unnamed')
  });
  const view = sessionRowPresentation(copy, (name) => t('play.childTask.owner', { name }));
  const subtitle = rowSubtitleText(copy.kind, view.title, preview.text, view.subtitle);
  const botId = sessionWorkBotId(session, bots);
  const mood = useBotWorkMood(botId);

  return (
    <div
      ref={preview.row}
      className={sessionListRowClass(view.bot, selected, checked)}
      role="button"
      tabIndex={0}
      data-session-id={session.id}
      data-session-kind={copy.kind}
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        if (selectMode) {
          onToggleChecked(!checked);
          return;
        }
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        if (selectMode) onToggleChecked(!checked);
        else onOpen();
      }}
    >
      {selectMode ? (
        <input
          type="checkbox"
          className="session-item__check"
          checked={checked}
          disabled={deleting}
          aria-label={t('play.sidebar.checkboxAria', { title: view.title })}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onToggleChecked(event.target.checked)}
        />
      ) : null}
      {view.bot ? (
        <span className="session-item__face" data-bot-face-slot="" style={{ '--bot-face-idle-delay': botFaceIdleDelay(view.faceName) } as CSSProperties}>
          <BotFace name={view.faceName} botId={botId} mood={mood} />
        </span>
      ) : null}
      <div className="session-item__body">
        <PlainSessionTitle
          kind={copy.kind}
          title={view.title}
          showWhen={showWhen}
          updatedAt={session.updatedAt}
          createdAt={session.createdAt}
        />
        <div className="session-item__meta">
          {status}
          <SessionRowSubtitle bot={view.bot} subtitle={subtitle} hasQuestion={view.hasQuestion} agentId={session.agentId} owner={view.owner} />
        </div>
      </div>
      {rowActions}
      <SessionRowDeleteGate title={view.title} deleting={deleting} selectMode={selectMode} confirm={confirm} onDelete={onDelete}
        deleteAria={deleteAria} deleteLabel={deleteLabel} confirmLabel={confirmLabel} />
    </div>
  );
}

type DeleteLabels = { deleteAria?: string; deleteLabel?: string; confirmLabel?: string };

function useDeleteLabels(armed: boolean, title: string, labels: DeleteLabels) {
  const { t } = useI18n();
  if (armed) {
    const text = labels.confirmLabel ?? t('play.sidebar.confirmDelete');
    return { text, aria: text };
  }
  return {
    text: labels.deleteLabel ?? t('play.sidebar.deleteOne'),
    aria: labels.deleteAria ?? t('play.sidebar.deleteOneAria', { title })
  };
}

function SessionRowDeleteGate(props: DeleteLabels & {
  title: string;
  deleting: boolean;
  selectMode: boolean;
  confirm: ReturnType<typeof useArmedConfirm>;
  onDelete?: (title: string) => void;
}) {
  if (!props.onDelete || props.selectMode) return null;
  return <SessionRowDelete title={props.title} deleting={props.deleting} confirm={props.confirm} onDelete={props.onDelete}
    deleteAria={props.deleteAria} deleteLabel={props.deleteLabel} confirmLabel={props.confirmLabel} />;
}

function SessionRowDelete(props: DeleteLabels & {
  title: string; deleting: boolean; confirm: ReturnType<typeof useArmedConfirm>; onDelete: (title: string) => void;
}) {
  const { title, deleting, confirm, onDelete } = props;
  const labels = useDeleteLabels(confirm.armed, title, props);
  return <button type="button" className="btn btn-ghost btn-sm session-item__delete"
    disabled={deleting} data-armed={String(confirm.armed)} aria-label={labels.aria}
    onPointerDown={confirm.onPointerDown} onClick={(event) => confirm.onClick(event, () => onDelete(title))}>
    {labels.text}
  </button>;
}

function PlainSessionTitle({
  kind,
  title,
  showWhen,
  updatedAt,
  createdAt
}: {
  kind: string;
  title: string;
  showWhen: boolean;
  updatedAt?: string;
  createdAt?: string;
}) {
  const { t } = useI18n();
  if (kind !== 'plain' || !showWhen) return <div className="session-item__title">{title}</div>;
  const when = sessionListWhenText(sessionListWhen(sessionActivityAt({ updatedAt, createdAt })), t);
  return (
    <div className="session-item__title-row">
      <div className="session-item__title">{title}</div>
      {when ? <time className="session-item__when" dateTime={updatedAt || createdAt}>{when}</time> : null}
    </div>
  );
}

function PlainSessionMeta({ subtitle, agentId }: { subtitle: string; agentId?: string }) {
  if (!subtitle) return <SessionRowAgentId agentId={agentId} />;
  return (
    <>
      <span className="session-item__question-text" data-testid="session-plain-preview">{subtitle}</span>
      <SessionRowAgentId agentId={agentId} />
    </>
  );
}

function SessionRowAgentId({ agentId }: { agentId?: string }) {
  if (!agentId || isCoreExecAgent(agentId)) return null;
  return <span className="session-item__agent">{agentId}</span>;
}

function SessionRowSubtitle({ bot, subtitle, hasQuestion, agentId, owner }: { bot: boolean; subtitle: string; hasQuestion: boolean; agentId?: string; owner?: string }) {
  if (owner) {
    return <span className="session-item__agent session-item__owner" data-testid="session-child-task-owner">{owner}</span>;
  }
  if (!bot) return <PlainSessionMeta subtitle={subtitle} agentId={agentId} />;
  const questionClass = hasQuestion ? 'session-item__question is-question' : 'session-item__question';
  return (
    <div className={questionClass}>
      <span className="session-item__question-text">{subtitle}</span>
    </div>
  );
}

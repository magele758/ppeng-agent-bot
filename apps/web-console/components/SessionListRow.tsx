'use client';

import type { ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { sessionRowCopy } from '@/lib/session-row';
import { BotFace } from './BotFace';

function isCoreExecAgent(id: string): boolean {
  return id === 'general' || id === 'main';
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
  onOpen,
  onToggleChecked,
  onDelete
}: {
  session: SessionSummary;
  bots: readonly BotInfo[];
  question: string;
  selected: boolean;
  checked: boolean;
  selectMode: boolean;
  deleting: boolean;
  status: ReactNode;
  onOpen: () => void;
  onToggleChecked: (checked: boolean) => void;
  onDelete?: (title: string) => void;
}) {
  const { t } = useI18n();
  const copy = sessionRowCopy({
    session,
    bots,
    question,
    emptyHint: t('play.sidebar.noQuestion'),
    unnamed: t('play.unnamed')
  });
  const title = copy.title;
  const bot = copy.kind === 'bot';
  const faceName = copy.kind === 'bot' ? copy.faceName : '';
  const subtitle = copy.kind === 'bot' ? copy.subtitle : '';
  const hasQuestion = copy.kind === 'bot' && copy.hasQuestion;

  return (
    <div
      className={`list-item list-item--session${bot ? ' list-item--bot-chat' : ''}${selected ? ' selected' : ''}${checked ? ' is-checked' : ''}`}
      role="button"
      tabIndex={0}
      data-session-kind={bot ? 'bot' : 'plain'}
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
          aria-label={t('play.sidebar.checkboxAria', { title })}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onToggleChecked(event.target.checked)}
        />
      ) : null}
      {bot ? (
        <span className="session-item__face" data-bot-face-slot="">
          <BotFace name={faceName} />
        </span>
      ) : null}
      <div className="session-item__body">
        <div className="session-item__title">{title}</div>
        <div className="session-item__meta">
          {status}
          {bot ? (
            <div className={`session-item__question${hasQuestion ? ' is-question' : ''}`}>
              <span className="session-item__question-text">{subtitle}</span>
            </div>
          ) : session.agentId && !isCoreExecAgent(session.agentId) ? (
            <span className="session-item__agent">{session.agentId}</span>
          ) : null}
        </div>
      </div>
      {onDelete && !selectMode ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm session-item__delete"
          disabled={deleting}
          aria-label={t('play.sidebar.deleteOneAria', { title })}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(title);
          }}
        >
          {t('play.sidebar.deleteOne')}
        </button>
      ) : null}
    </div>
  );
}

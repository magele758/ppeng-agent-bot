'use client';

import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { botFaceIdleDelay } from '@/lib/bot-face';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { sessionRowCopy, sessionWorkBotId } from '@/lib/session-row';
import { BotFace } from './BotFace';
import { useBotWorkMood } from './bot-work/BotWorkState';

function isCoreExecAgent(id: string): boolean {
  return id === 'general' || id === 'main';
}

function pointerOpensRow(event: PointerEvent<HTMLElement>, selectMode: boolean): boolean {
  if (selectMode || event.button !== 0) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest('button, a, input, textarea, select'));
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
  onDelete,
  deleteAria,
  deleteLabel
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
  deleteAria?: string;
  deleteLabel?: string;
}) {
  const { t } = useI18n();
  const openedByPointer = useRef(false);
  const copy = sessionRowCopy({
    session,
    bots,
    question,
    emptyHint: t('play.sidebar.noQuestion'),
    unnamed: t('play.unnamed')
  });
  const botId = sessionWorkBotId(session, bots);
  const mood = useBotWorkMood(botId);
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
      onPointerDown={(event) => {
        if (!pointerOpensRow(event, selectMode)) return;
        openedByPointer.current = true;
        onOpen();
      }}
      onClick={() => {
        if (selectMode) {
          onToggleChecked(!checked);
          return;
        }
        if (openedByPointer.current) {
          openedByPointer.current = false;
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
        <span className="session-item__face" data-bot-face-slot="" style={{ '--bot-face-idle-delay': botFaceIdleDelay(faceName) } as CSSProperties}>
          <BotFace name={faceName} mood={mood} />
        </span>
      ) : null}
      <div className="session-item__body">
        <div className="session-item__title">{title}</div>
        <div className="session-item__meta">
          {status}
          <SessionRowSubtitle bot={bot} subtitle={subtitle} hasQuestion={hasQuestion} agentId={session.agentId} />
        </div>
      </div>
      {onDelete && !selectMode ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm session-item__delete"
          disabled={deleting}
          aria-label={deleteAria ?? t('play.sidebar.deleteOneAria', { title })}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(title);
          }}
        >
          {deleteLabel ?? t('play.sidebar.deleteOne')}
        </button>
      ) : null}
    </div>
  );
}

function SessionRowSubtitle({ bot, subtitle, hasQuestion, agentId }: { bot: boolean; subtitle: string; hasQuestion: boolean; agentId?: string }) {
  return bot ? (
    <div className={`session-item__question${hasQuestion ? ' is-question' : ''}`}>
      <span className="session-item__question-text">{subtitle}</span>
    </div>
  ) : agentId && !isCoreExecAgent(agentId) ? (
    <span className="session-item__agent">{agentId}</span>
  ) : null;
}

'use client';

import { useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { botForCanonicalSession } from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import {
  BOT_DRAG_MIME,
  BOT_PIN_DRAG_MIME,
  commitBotPinState,
  getBotPinServerSnapshot,
  getBotPinSnapshot,
  nextStateAfterPinDragEnd,
  pinDragKind,
  resultOfPinAreaDrop,
  subscribeBotPins,
  visiblePinnedBots
} from '@/lib/bot-pin-area';
import styles from './BotFunctionalGroups.module.css';

function sessionForBot(
  bot: BotInfo,
  bots: readonly BotInfo[],
  sessions: readonly SessionSummary[]
): SessionSummary | undefined {
  if (bot.canonicalSessionId) {
    const direct = sessions.find((session) => session.id === bot.canonicalSessionId);
    if (direct) return direct;
  }
  return sessions.find((session) => botForCanonicalSession(bots, session.id, sessions)?.id === bot.id);
}

export function BotPinArea({
  bots,
  sessions,
  renderSession,
  onOpenSession,
  active = true
}: {
  active?: boolean;
  bots: readonly BotInfo[];
  sessions: readonly SessionSummary[];
  renderSession: (session: SessionSummary) => ReactNode;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);
  const [over, setOver] = useState(false);
  const landedInside = useRef(false);
  const draggingId = useRef<string | null>(null);
  const stateRef = useRef(state);
  const botsRef = useRef(bots);
  stateRef.current = state;
  botsRef.current = bots;
  const pinned = visiblePinnedBots(bots, state);

  const openSession = (sessionId: string) => {
    if (!sessionId) return;
    onOpenSession(sessionId);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    const kind = pinDragKind(event.dataTransfer.types);
    if (kind === 'ignore') return;
    event.preventDefault();
    const moving = kind === 'bot' || kind === 'pin';
    event.dataTransfer.dropEffect = moving ? 'move' : 'none';
    setOver(moving);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const decision = resultOfPinAreaDrop(
      stateRef.current,
      botsRef.current,
      event.dataTransfer.types,
      event.dataTransfer.getData(BOT_DRAG_MIME)
    );
    if (!decision.accept) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    if (decision.landedInside) {
      landedInside.current = true;
      return;
    }
    if (decision.next) commitBotPinState(decision.next);
  };

  if (!active) return null;
  return (
    <section
      className={`${styles.pin}${over ? ` ${styles.dropTarget}` : ''}`}
      data-testid="bot-pin-area"
      aria-labelledby="bot-pin-title"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className={styles.heading}>
        <h3 id="bot-pin-title">{t('play.pin.title')}</h3>
      </div>
      {pinned.length === 0 ? <p className={styles.empty}>{t('play.pin.empty')}</p> : <p className={styles.hint}>{t('play.pin.hint')}</p>}
      {pinned.map((bot) => {
        const session = sessionForBot(bot, bots, sessions);
        const sessionId = session?.id || bot.canonicalSessionId || '';
        const row = session ? renderSession(session) : null;
        return (
          <div
            key={bot.id}
            className={styles.draggable}
            draggable
            data-testid="bot-pin-item"
            data-bot-id={bot.id}
            data-bot-name={bot.name}
            onDragStart={(event) => {
              draggingId.current = bot.id;
              landedInside.current = false;
              event.dataTransfer.setData(BOT_PIN_DRAG_MIME, bot.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              if (draggingId.current !== bot.id) return;
              draggingId.current = null;
              const inside = landedInside.current;
              landedInside.current = false;
              setOver(false);
              const next = nextStateAfterPinDragEnd(stateRef.current, botsRef.current, bot.id, inside);
              if (next) commitBotPinState(next);
            }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              openSession(sessionId);
            }}
          >
            {row ?? (
              <div
                className="list-item list-item--session list-item--bot-chat"
                role="button"
                tabIndex={0}
                onClick={() => openSession(sessionId)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  openSession(sessionId);
                }}
              >
                <div className="session-item__body">
                  <div className="session-item__title">{bot.name}</div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

'use client';

import { useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { sessionForPinnedBot } from '@/lib/bots';
import { useI18n } from '@/lib/i18n';
import {
  BOT_DRAG_MIME,
  BOT_PIN_DRAG_MIME,
  ROOM_DRAG_MIME,
  ROOM_PIN_DRAG_MIME,
  arrangeSidebarRows,
  beginSidebarDrag,
  commitBotPinState,
  commitRegionOrder,
  currentSidebarDrag,
  dropPlace,
  endSidebarDrag,
  getBotPinServerSnapshot,
  getBotPinSnapshot,
  moveSidebarItem,
  nextStateAfterPinDragEnd,
  nextStateAfterRoomPinDragEnd,
  orderRegionKey,
  pinDragKind,
  regionRefs,
  resultOfPinAreaDrop,
  sameOrderRegion,
  savedRegionRefs,
  subscribeBotPins,
  visiblePinnedBots,
  visiblePinnedRooms
} from '@/lib/bot-pin-area';
import { PlayGroupRow, deletePlayRoom, type SidebarRoom } from './play-group/PlayBotGroupList';
import styles from './BotFunctionalGroups.module.css';

export function BotPinArea({
  bots,
  sessions,
  rooms = [],
  renderSession,
  onOpenSession,
  onOpenRoom,
  onRoomDeleted,
  selectedRoomId = null,
  active = true
}: {
  active?: boolean;
  bots: readonly BotInfo[];
  sessions: readonly SessionSummary[];
  rooms?: readonly SidebarRoom[];
  renderSession: (session: SessionSummary) => ReactNode;
  onOpenSession: (sessionId: string) => void;
  onOpenRoom?: (roomId: string) => void;
  onRoomDeleted?: (roomId: string) => void;
  selectedRoomId?: string | null;
}) {
  const { t } = useI18n();
  const state = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);
  const [over, setOver] = useState(false);
  const [insert, setInsert] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const landedInside = useRef(false);
  const draggingId = useRef<string | null>(null);
  const draggingKind = useRef<'bot' | 'room' | null>(null);
  const stateRef = useRef(state);
  const botsRef = useRef(bots);
  const roomsRef = useRef(rooms);
  stateRef.current = state;
  botsRef.current = bots;
  roomsRef.current = rooms;
  const pinned = visiblePinnedBots(bots, state);
  const pinnedRooms = visiblePinnedRooms(rooms, state);
  const pinRegion = { type: 'pin' as const };
  const ordered = arrangeSidebarRows(
    pinned.map((bot) => ({ kind: 'bot' as const, id: bot.id, value: bot })),
    pinnedRooms.map((room) => ({ kind: 'room' as const, id: room.id, value: room })),
    savedRegionRefs(state, pinRegion)
  );

  const reorderOver = (event: DragEvent<HTMLDivElement>, kind: 'bot' | 'room', id: string) => {
    const drag = currentSidebarDrag();
    if (!drag || !sameOrderRegion(drag.region, pinRegion)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setInsert(`${kind}:${id}:${dropPlace(event.clientY, rect.top, rect.height)}`);
  };

  const reorderDrop = (event: DragEvent<HTMLDivElement>, kind: 'bot' | 'room', id: string) => {
    const drag = currentSidebarDrag();
    if (!drag || !sameOrderRegion(drag.region, pinRegion)) return;
    event.preventDefault();
    event.stopPropagation();
    landedInside.current = true;
    const rect = event.currentTarget.getBoundingClientRect();
    const next = moveSidebarItem(
      regionRefs(ordered),
      { kind: drag.kind, id: drag.id },
      { kind, id },
      dropPlace(event.clientY, rect.top, rect.height)
    );
    if (next) commitRegionOrder(stateRef.current, pinRegion, next);
    setInsert(null);
  };

  const openSession = (sessionId: string) => {
    if (!sessionId) return;
    onOpenSession(sessionId);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    const kind = pinDragKind(event.dataTransfer.types);
    if (kind === 'ignore') return;
    event.preventDefault();
    const moving = kind === 'bot' || kind === 'room' || kind === 'pin';
    event.dataTransfer.dropEffect = moving ? 'move' : 'none';
    setOver(moving);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const decision = resultOfPinAreaDrop(
      stateRef.current,
      botsRef.current,
      event.dataTransfer.types,
      event.dataTransfer.getData(BOT_DRAG_MIME),
      roomsRef.current,
      event.dataTransfer.getData(ROOM_DRAG_MIME)
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
      {deleteError ? <p role="alert" className="play-group-error">{deleteError}</p> : null}
      {ordered.length === 0 ? <p className={styles.empty}>{t('play.pin.empty')}</p> : <p className={styles.hint}>{t('play.pin.hint')}</p>}
      {ordered.map((entry) => {
        const place = insert?.startsWith(`${entry.kind}:${entry.id}:`) ? insert.slice(entry.kind.length + entry.id.length + 1) : '';
        const insertClass = place === 'before' ? styles.insertBefore : place === 'after' ? styles.insertAfter : '';
        if (entry.kind === 'bot') {
          const bot = entry.value;
          const session = sessionForPinnedBot(bot, bots, sessions);
          const sessionId = session?.id || bot.canonicalSessionId || '';
          const row = session ? renderSession(session) : null;
          return (
            <div
              key={`bot:${bot.id}`}
              className={`${styles.draggable}${insertClass ? ` ${insertClass}` : ''}`}
              draggable
              title={t('play.sidebar.reorder')}
              data-testid="bot-pin-item"
              data-reorder-region={orderRegionKey(pinRegion)}
              data-bot-id={bot.id}
              data-bot-name={bot.name}
              onDragOver={(event) => reorderOver(event, 'bot', bot.id)}
              onDrop={(event) => reorderDrop(event, 'bot', bot.id)}
              onDragStart={(event) => {
                beginSidebarDrag({ kind: 'bot', id: bot.id, region: pinRegion });
                draggingKind.current = 'bot';
                draggingId.current = bot.id;
                landedInside.current = false;
                event.dataTransfer.setData(BOT_PIN_DRAG_MIME, bot.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                endSidebarDrag();
                setInsert(null);
                if (draggingKind.current !== 'bot' || draggingId.current !== bot.id) return;
                draggingKind.current = null;
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
        }
        const room = entry.value;
        const names = room.botIds.map((id) => bots.find((bot) => bot.id === id)?.name ?? id).join('、');
        return (
          <div
            key={`room:${room.id}`}
            className={`${styles.draggable}${insertClass ? ` ${insertClass}` : ''}`}
            draggable
            title={t('play.sidebar.reorder')}
            data-testid="room-pin-item"
            data-reorder-region={orderRegionKey(pinRegion)}
            data-room-id={room.id}
            data-room-title={room.title}
            onDragOver={(event) => reorderOver(event, 'room', room.id)}
            onDrop={(event) => reorderDrop(event, 'room', room.id)}
            onDragStart={(event) => {
              beginSidebarDrag({ kind: 'room', id: room.id, region: pinRegion });
              draggingKind.current = 'room';
              draggingId.current = room.id;
              landedInside.current = false;
              event.dataTransfer.setData(ROOM_PIN_DRAG_MIME, room.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              endSidebarDrag();
              setInsert(null);
              if (draggingKind.current !== 'room' || draggingId.current !== room.id) return;
              draggingKind.current = null;
              draggingId.current = null;
              const inside = landedInside.current;
              landedInside.current = false;
              setOver(false);
              const next = nextStateAfterRoomPinDragEnd(stateRef.current, botsRef.current, roomsRef.current, room.id, inside);
              if (next) commitBotPinState(next);
            }}
          >
            <PlayGroupRow
              room={room}
              names={names}
              selected={selectedRoomId === room.id}
              busy={deletingId === room.id}
              disabled={deletingId !== null}
              placement="pin"
              onOpen={() => onOpenRoom?.(room.id)}
              onDelete={() => {
                setDeleteError('');
                void deletePlayRoom(room, t, deletingId, setDeletingId).then((result) => {
                  if (result === 'failed') setDeleteError(t('play.group.deleteFailed'));
                  if (result === 'deleted') onRoomDeleted?.(room.id);
                });
              }}
            />
          </div>
        );
      })}
    </section>
  );
}

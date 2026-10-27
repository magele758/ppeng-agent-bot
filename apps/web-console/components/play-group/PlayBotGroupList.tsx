'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { sameData } from '@/lib/same-data';
import { useI18n, type I18nContextValue } from '@/lib/i18n';
import {
  BOT_GROUPS_CHANGED_EVENT,
  groupMatchesQuery,
} from '@/lib/bot-group';
import { displayPinnedRoomIds, type OrderRegion } from '@/lib/bot-pin';
import {
  arrangeSidebarRows,
  beginSidebarDrag,
  commitRegionOrder,
  currentSidebarDrag,
  dropPlace,
  endSidebarDrag,
  getBotPinServerSnapshot,
  getBotPinSnapshot,
  moveSidebarItem,
  orderRegionKey,
  regionRefs,
  ROOM_DRAG_MIME,
  sameOrderRegion,
  savedRegionRefs,
  subscribeBotPins
} from '@/lib/bot-pin-area';
import {
  FUNCTIONAL_GROUPS_CHANGED_EVENT,
  looseRooms,
} from '@/lib/functional-group-view';
import { WorkspaceIcon } from '../WorkspaceIcon';
import './play-group.css';

export type SidebarRoom = {
  id: string;
  title: string;
  botIds: string[];
  status?: string;
};

type PlacementGroup = { id: string; roomIds?: string[] };

export async function deletePlayRoom(
  room: { id: string; title: string },
  t: I18nContextValue['t'],
  deletingId: string | null,
  setDeletingId: (id: string | null) => void
): Promise<'deleted' | 'cancelled' | 'failed'> {
  if (deletingId || !window.confirm(t('play.group.deleteConfirm', { title: room.title }))) return 'cancelled';
  setDeletingId(room.id);
  try {
    await api(`/api/bot-rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
    window.dispatchEvent(new Event(BOT_GROUPS_CHANGED_EVENT));
    return 'deleted';
  } catch {
    return 'failed';
  } finally {
    setDeletingId(null);
  }
}

export function PlayGroupRow({
  room,
  names,
  selected,
  busy,
  disabled,
  draggable = false,
  placement,
  className,
  onOpen,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  room: SidebarRoom;
  names: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  draggable?: boolean;
  placement: 'loose' | 'group' | 'pin';
  className?: string;
  onOpen: () => void;
  onDelete: () => void;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`list-item list-item--session list-item--group${selected ? ' selected' : ''}${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      data-testid="play-group-row"
      data-room-id={room.id}
      data-room-title={room.title}
      data-room-placement={placement}
      data-reorder-region={placement === 'loose' ? 'loose' : undefined}
      draggable={draggable || undefined}
      title={t('play.sidebar.reorder')}
      aria-current={selected ? 'true' : undefined}
      aria-label={t('play.group.openAria', { title: room.title })}
      onClick={() => onOpen()}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="session-item__body">
        <div className="session-item__title">{room.title}</div>
        <div className="session-item__meta">
          <span className="play-group-badge">{t('play.group.badge')}</span>
          <span className="session-item__agent">{names}</span>
        </div>
      </div>
      <div className="play-group-menu" data-testid="play-group-menu">
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm play-group-delete"
          aria-label={t('play.group.deleteAria', { title: room.title })}
          title={busy ? t('play.group.deleting') : t('play.group.deleteLabel')}
          aria-busy={busy}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          data-testid="play-group-delete"
        >
          <WorkspaceIcon kind="trash" />
        </button>
      </div>
    </div>
  );
}

export function PlayBotGroupList({
  bots,
  selectedId,
  filter,
  onOpen,
  onDeleted,
  onCount,
  onRooms,
}: {
  bots: readonly BotInfo[];
  selectedId: string | null;
  filter: string;
  onOpen: (id: string) => void;
  onDeleted?: (id: string) => void;
  onCount?: (count: number) => void;
  onRooms?: (rooms: SidebarRoom[]) => void;
}) {
  const { t } = useI18n();
  const [rooms, setRooms] = useState<SidebarRoom[]>([]);
  const [placementGroups, setPlacementGroups] = useState<PlacementGroup[]>([]);
  const [placementReady, setPlacementReady] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [insert, setInsert] = useState<string | null>(null);
  const roomRevision = useRef(0);
  const placementRevision = useRef(0);
  const pinState = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);

  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const pinnedRoomIds = displayPinnedRoomIds(rooms, pinState);
  const loose = placementReady ? looseRooms(rooms, placementGroups, pinnedRoomIds) : [];
  const visible = loose.filter((room) => groupMatchesQuery(room, filter, nameOf));
  const looseRegion: OrderRegion = { type: 'looseRooms' };
  const arranged = arrangeSidebarRows(
    [],
    loose.map((room) => ({ kind: 'room' as const, id: room.id, value: room })),
    savedRegionRefs(pinState, looseRegion)
  );
  const visibleIds = new Set(visible.map((room) => room.id));
  const ordered = arranged.filter((row) => visibleIds.has(row.id));

  useEffect(() => {
    onCount?.(visible.length);
  }, [visible.length, onCount]);

  useEffect(() => {
    onRooms?.(rooms);
  }, [rooms, onRooms]);

  useEffect(() => {
    let active = true;
    const loadRooms = () => {
      const revision = roomRevision.current;
      void api('/api/bot-rooms')
        .then((data) => {
          if (!active || revision !== roomRevision.current) return;
          const list = (data as { rooms?: SidebarRoom[] }).rooms;
          const next = Array.isArray(list) ? list : [];
          setRooms((prev) => (sameData(prev, next) ? prev : next));
        })
        .catch(() => {
          // Preserve the last known list on a transient polling failure.
        });
    };
    const loadGroups = () => {
      const revision = placementRevision.current;
      void api('/api/bot-functional-groups')
        .then((data) => {
          if (!active || revision !== placementRevision.current) return;
          const list = (data as { groups?: PlacementGroup[] }).groups;
          setPlacementGroups(Array.isArray(list) ? list : []);
          setPlacementReady(true);
        })
        .catch(() => {
          if (active && revision === placementRevision.current) setPlacementReady(true);
        });
    };
    loadRooms();
    loadGroups();
    const timer = setInterval(loadRooms, 2000);
    const onChanged = () => {
      roomRevision.current += 1;
      loadRooms();
    };
    const onPlacement = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (Array.isArray(detail)) {
        placementRevision.current += 1;
        setPlacementGroups(detail as PlacementGroup[]);
        setPlacementReady(true);
        return;
      }
      loadGroups();
    };
    window.addEventListener(BOT_GROUPS_CHANGED_EVENT, onChanged);
    window.addEventListener(FUNCTIONAL_GROUPS_CHANGED_EVENT, onPlacement);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_GROUPS_CHANGED_EVENT, onChanged);
      window.removeEventListener(FUNCTIONAL_GROUPS_CHANGED_EVENT, onPlacement);
    };
  }, []);

  const deleteGroup = async (room: SidebarRoom) => {
    setDeleteError('');
    const result = await deletePlayRoom(room, t, deletingId, setDeletingId);
    if (result === 'failed') setDeleteError(t('play.group.deleteFailed'));
    if (result !== 'deleted') return;
    roomRevision.current += 1;
    setRooms((prev) => prev.filter((item) => item.id !== room.id));
    onDeleted?.(room.id);
  };

  return (
    <div className="play-group-block">
      {deleteError ? <p role="alert" className="play-group-error" data-testid="play-group-delete-error">{deleteError}</p> : null}
      {ordered.map((entry) => {
        const room = entry.value;
        const names = room.botIds.map(nameOf).join('、');
        const placeKey = `${room.id}:`;
        const place = insert?.startsWith(placeKey) ? insert.slice(placeKey.length) : '';
        return (
          <PlayGroupRow
            key={room.id}
            room={room}
            names={names}
            selected={selectedId === room.id}
            busy={deletingId === room.id}
            disabled={deletingId !== null}
            draggable
            placement="loose"
            className={place === 'before' ? 'is-insert-before' : place === 'after' ? 'is-insert-after' : undefined}
            onOpen={() => onOpen(room.id)}
            onDelete={() => { void deleteGroup(room); }}
            onDragOver={(event) => {
              const drag = currentSidebarDrag();
              if (!drag || !sameOrderRegion(drag.region, looseRegion)) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setInsert(`${room.id}:${dropPlace(event.clientY, rect.top, rect.height)}`);
            }}
            onDrop={(event) => {
              const drag = currentSidebarDrag();
              if (!drag || !sameOrderRegion(drag.region, looseRegion)) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              const next = moveSidebarItem(
                regionRefs(arranged),
                { kind: 'room', id: drag.id },
                { kind: 'room', id: room.id },
                dropPlace(event.clientY, rect.top, rect.height)
              );
              if (next) commitRegionOrder(pinState, looseRegion, next);
              setInsert(null);
            }}
            onDragStart={(event) => {
              beginSidebarDrag({ kind: 'room', id: room.id, region: looseRegion });
              event.dataTransfer.setData(ROOM_DRAG_MIME, room.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => { endSidebarDrag(); setInsert(null); }}
          />
        );
      })}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { sameData } from '@/lib/same-data';
import { useI18n } from '@/lib/i18n';
import {
  BOT_GROUPS_CHANGED_EVENT,
  groupMatchesQuery,
} from '@/lib/bot-group';
import './play-group.css';

type Room = {
  id: string;
  title: string;
  botIds: string[];
  status: string;
};

export function PlayBotGroupList({
  bots,
  selectedId,
  filter,
  onOpen,
  onDeleted,
  onCount
}: {
  bots: readonly BotInfo[];
  selectedId: string | null;
  filter: string;
  onOpen: (id: string) => void;
  onDeleted?: (id: string) => void;
  onCount?: (count: number) => void;
}) {
  const { t } = useI18n();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const roomRevision = useRef(0);

  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const visible = rooms.filter((room) => groupMatchesQuery(room, filter, nameOf));

  useEffect(() => {
    onCount?.(visible.length);
  }, [visible.length, onCount]);

  useEffect(() => {
    let active = true;
    const load = () => {
      const revision = roomRevision.current;
      void api('/api/bot-rooms')
        .then((data) => {
          if (!active || revision !== roomRevision.current) return;
          const list = (data as { rooms?: Room[] }).rooms;
          const next = Array.isArray(list) ? list : [];
          setRooms((prev) => (sameData(prev, next) ? prev : next));
        })
        .catch(() => {
          // Preserve the last known list on a transient polling failure.
        });
    };
    load();
    const timer = setInterval(load, 2000);
    const onChanged = () => load();
    window.addEventListener(BOT_GROUPS_CHANGED_EVENT, onChanged);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_GROUPS_CHANGED_EVENT, onChanged);
    };
  }, []);

  const deleteGroup = async (room: Room) => {
    if (deletingId || !window.confirm(t('play.group.deleteConfirm', { title: room.title }))) return;
    setDeletingId(room.id);
    setDeleteError('');
    try {
      await api(`/api/bot-rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
      roomRevision.current++;
      setRooms((prev) => prev.filter((item) => item.id !== room.id));
      onDeleted?.(room.id);
      window.dispatchEvent(new Event(BOT_GROUPS_CHANGED_EVENT));
    } catch {
      setDeleteError(t('play.group.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="play-group-block">
      {deleteError ? <p role="alert" className="play-group-error" data-testid="play-group-delete-error">{deleteError}</p> : null}
      {visible.map((room) => {
        const names = room.botIds.map(nameOf).join('、');
        const selected = selectedId === room.id;
        return (
          <div
            key={room.id}
            className={`list-item list-item--session list-item--group${selected ? ' selected' : ''}`}
            role="button"
            tabIndex={0}
            data-testid="play-group-row"
            draggable={false}
            aria-current={selected ? 'true' : undefined}
            aria-label={t('play.group.openAria', { title: room.title })}
            onClick={() => onOpen(room.id)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onOpen(room.id);
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
            <button
              type="button"
              className="btn btn-ghost btn-sm play-group-delete"
              data-testid="play-group-delete"
              aria-label={t('play.group.deleteAria', { title: room.title })}
              disabled={deletingId !== null}
              onClick={(event) => {
                event.stopPropagation();
                void deleteGroup(room);
              }}
            >
              {deletingId === room.id ? t('play.group.deleting') : t('play.group.deleteLabel')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

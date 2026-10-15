'use client';

import { useEffect, useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  BOT_GROUPS_CHANGED_EVENT,
  groupMatchesQuery,
  groupMemberIds,
  groupSpeakBudget,
  type GroupMemberCode
} from '@/lib/bot-group';
import './play-group.css';

type Room = {
  id: string;
  title: string;
  botIds: string[];
  status: string;
};

function issueKey(code: GroupMemberCode): MessageKey {
  switch (code) {
    case 'need_two':
      return 'play.group.needTwo';
    case 'duplicate':
      return 'play.group.duplicate';
    case 'blank':
      return 'play.group.blank';
    case 'unknown':
      return 'play.group.unknown';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

export function PlayBotGroupList({
  bots,
  selectedId,
  filter,
  onOpen,
  onCount
}: {
  bots: readonly BotInfo[];
  selectedId: string | null;
  filter: string;
  onOpen: (id: string) => void;
  onCount?: (count: number) => void;
}) {
  const { t } = useI18n();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const visible = rooms.filter((room) => groupMatchesQuery(room, filter, nameOf));

  useEffect(() => {
    onCount?.(visible.length);
  }, [visible.length, onCount]);

  useEffect(() => {
    let active = true;
    const load = () => {
      void api('/api/bot-rooms')
        .then((data) => {
          if (!active) return;
          const list = (data as { rooms?: Room[] }).rooms;
          setRooms(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          if (active) setRooms([]);
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

  const toggleMember = (id: string) => {
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    setError('');
  };

  const createGroup = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120) {
      setError(t('play.group.titleInvalid'));
      return;
    }
    const known = new Set(bots.map((bot) => bot.id));
    const members = groupMemberIds(memberIds, known);
    if (!members.ok) {
      setError(t(issueKey(members.code)));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = (await api(
        '/api/bot-rooms',
        jsonBody({
          title: trimmed,
          botIds: members.members,
          hostBotId: members.members[0],
          maxBotTurns: groupSpeakBudget(members.members.length)
        })
      )) as { room?: Room };
      const room = data.room;
      if (!room?.id) throw new Error('missing room');
      setRooms((prev) => (prev.some((item) => item.id === room.id) ? prev : [...prev, room]));
      setTitle('');
      setMemberIds([]);
      setCreating(false);
      window.dispatchEvent(new Event(BOT_GROUPS_CHANGED_EVENT));
      onOpen(room.id);
    } catch {
      setError(t('play.group.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="play-group-block">
      <button
        type="button"
        className="btn btn-ghost btn-sm play-group-create"
        data-testid="play-group-create"
        aria-expanded={creating}
        onClick={() => {
          setCreating((open) => !open);
          setError('');
        }}
      >
        {t('play.group.create')}
      </button>
      {creating ? (
        <form
          className="play-group-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createGroup();
          }}
        >
          <label>
            {t('play.group.title')}
            <input
              className="input-compact"
              value={title}
              maxLength={120}
              placeholder={t('play.group.titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <span>{t('play.group.members')}</span>
          <p className="play-group-hint">{t('play.group.participateHint')}</p>
          {bots.length < 2 ? (
            <p className="play-group-error">{t('play.group.needTwo')}</p>
          ) : (
            <ul className="play-group-picker">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={memberIds.includes(bot.id)}
                      onChange={() => toggleMember(bot.id)}
                    />
                    {bot.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error ? <p className="play-group-error">{error}</p> : null}
          <div className="play-group-form__actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || bots.length < 2}>
              {busy ? t('play.creating') : t('play.group.submit')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setCreating(false);
                setError('');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : null}
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
            aria-current={selected ? 'true' : undefined}
            aria-label={t('play.group.openAria', { title: room.title })}
            onClick={() => onOpen(room.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onOpen(room.id);
            }}
          >
            <div className="session-item__body">
              <div className="session-item__title">{room.title}</div>
              <div className="session-item__meta">
                <span className="play-group-badge">{t('play.group.badge')}</span>
                <span className="session-item__agent">{names}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

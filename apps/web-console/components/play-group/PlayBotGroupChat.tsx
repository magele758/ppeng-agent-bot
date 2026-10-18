'use client';

import { useEffect, useRef, useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { mergeHistoryWindow } from '@/lib/history-window';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { renderMarkdown } from '@/lib/markdown';
import {
  BOT_GROUPS_CHANGED_EVENT,
  activeMentionQuery,
  addGroupMember,
  filterMentionMembers,
  groupSpeakBudget,
  insertMention,
  removeGroupMember,
  type GroupMemberCode
} from '@/lib/bot-group';
import { BotFace } from '../BotFace';
import './play-group.css';

type Room = {
  id: string;
  title: string;
  botIds: string[];
  hostBotId: string;
  status: string;
  maxBotTurns: number;
};

type RoomMessage = {
  id: string;
  seq: number;
  text: string;
  attachmentIds?: string[];
  sender: { type: 'user' | 'bot'; id: string; name: string };
};

type RoomTurn = { id: string; status: string; botIds?: string[]; mentionedBotIds?: string[]; cursor?: number };

function liveSpeakerId(turns: readonly RoomTurn[]): string {
  const live = turns.find((turn) => turn.status === 'running' || turn.status === 'queued' || turn.status === 'waiting_approval');
  if (!live?.botIds?.length) return '';
  const cursor = live.cursor ?? 0;
  const index = cursor >= 0 && cursor < live.botIds.length ? cursor : 0;
  return live.botIds[index] ?? '';
}

function issueKey(code: GroupMemberCode): MessageKey {
  switch (code) {
    case 'need_two':
      return 'play.group.keepTwo';
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

function GroupTurn({
  message,
  name,
  mood,
  attachmentLabel
}: {
  message: RoomMessage;
  name: string;
  mood: 'idle' | 'speaking';
  attachmentLabel?: string;
}) {
  const kind = message.sender.type;
  switch (kind) {
    case 'user':
    case 'bot':
      break;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
  const user = kind === 'user';
  return (
    <article className={`chat-turn play-group-turn${user ? ' chat-turn--user' : ' chat-turn--assistant play-group-turn--bot'}`}>
      {kind === 'bot' ? (
        <BotFace
          name={name}
          mood={mood}
          size="sm"
          className="play-group-turn__face"
          testId={`play-group-face-${message.id}`}
        />
      ) : null}
      <div className="chat-turn__content">
        <div className="chat-turn__label">{name}</div>
        <div className="chat-bubble">
          <div
            className="chat-bubble__body chat-bubble__md"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
          />
        </div>
        {attachmentLabel ? <p className="play-group-hint">{attachmentLabel}</p> : null}
      </div>
    </article>
  );
}

function senderName(message: RoomMessage, bots: readonly BotInfo[], me: string): string {
  if (message.sender.type === 'user') return me;
  if (message.sender.type === 'bot') {
    return bots.find((bot) => bot.id === message.sender.id)?.name ?? message.sender.name;
  }
  const exhaustive: never = message.sender.type;
  return exhaustive;
}

export function PlayBotGroupChat({ roomId, bots }: { roomId: string; bots: readonly BotInfo[] }) {
  const { t } = useI18n();
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [turns, setTurns] = useState<RoomTurn[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [addId, setAddId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const messagesRef = useRef<RoomMessage[]>([]);
  const roomIdRef = useRef(roomId);
  const feedRef = useRef<HTMLDivElement>(null);
  roomIdRef.current = roomId;

  const applyHistory = (
    page: { messages: RoomMessage[]; hasMore: boolean; nextCursor: number | null },
    older: boolean
  ) => {
    const firstLoad = messagesRef.current.length === 0;
    const next = older
      ? [...page.messages, ...messagesRef.current]
      : mergeHistoryWindow(messagesRef.current, page.messages, true).messages;
    messagesRef.current = next;
    setMessages(next);
    if (older || firstLoad) setCursor(page.hasMore ? page.nextCursor : null);
  };

  const loadRoom = async (older = false) => {
    const id = roomId;
    const historyUrl = `/api/bot-rooms/${id}/messages?limit=50${older && cursor ? `&beforeSeq=${cursor}` : ''}`;
    const [history, turnData, current] = (await Promise.all([
      api(historyUrl),
      api(`/api/bot-rooms/${id}/turns`),
      api(`/api/bot-rooms/${id}`)
    ])) as [
      { messages: RoomMessage[]; hasMore: boolean; nextCursor: number | null },
      { turns: RoomTurn[] },
      { room: Room }
    ];
    if (roomIdRef.current !== id) return;
    applyHistory(history, older);
    setTurns(Array.isArray(turnData.turns) ? turnData.turns : []);
    setRoom(current.room);
    setLoadError(false);
  };

  useEffect(() => {
    messagesRef.current = [];
    setMessages([]);
    setRoom(null);
    setTurns([]);
    setCursor(null);
    setText('');
    setAddId('');
    setError('');
    let active = true;
    const refresh = (older = false) => {
      void loadRoom(older).catch(() => {
        if (active && roomIdRef.current === roomId) setLoadError(true);
      });
    };
    refresh();
    const timer = setInterval(() => refresh(false), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // cursor is read only for the older-page action, not the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, roomId]);

  const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const descriptionOf = (id: string) => {
    const raw = bots.find((bot) => bot.id === id)?.description;
    return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  };
  const known = new Set(bots.map((bot) => bot.id));
  const speaking = turns.some((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_approval');
  const available = bots.filter((bot) => room && !room.botIds.includes(bot.id));
  const mentionMembers = (room?.botIds ?? []).map((id) => ({ id, name: nameOf(id) }));
  const mention = activeMentionQuery(text, caret);
  const mentionOptions = mention ? filterMentionMembers(mentionMembers, mention.query) : [];
  const mentionKey = mention ? `${mention.start}:${mention.query}` : '';
  const mentionOpen = Boolean(mention && mentionKey !== mentionDismissed && room?.status === 'active' && !busy);
  const activeMention = mentionOptions[Math.min(mentionIndex, Math.max(mentionOptions.length - 1, 0))];

  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const chooseMention = (name: string) => {
    if (!mention) return;
    const next = insertMention(text, mention.start, caret, name);
    setText(next.value);
    setCaret(next.caret);
    setMentionIndex(0);
    setMentionDismissed(`${mention.start}:${name}`);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const ensureBudget = async (next: Room) => {
    const needed = groupSpeakBudget(next.botIds.length);
    if (next.botIds.length >= 2 && next.maxBotTurns < needed) {
      const patched = (await api(`/api/bot-rooms/${next.id}`, jsonBody({ maxBotTurns: needed }, 'PATCH'))) as { room: Room };
      return patched.room;
    }
    return next;
  };

  const changeMembers = async (nextRoom: Room) => {
    const synced = await ensureBudget(nextRoom);
    setRoom(synced);
    setAddId('');
    window.dispatchEvent(new Event(BOT_GROUPS_CHANGED_EVENT));
  };

  const addMember = async () => {
    if (!room || !addId) return;
    const check = addGroupMember(room.botIds, addId, known);
    if (!check.ok) {
      setError(t(issueKey(check.code)));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = (await api(`/api/bot-rooms/${room.id}/members`, jsonBody({ botId: addId }))) as { room: Room };
      await changeMembers(data.room);
    } catch {
      setError(t('play.group.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (botId: string) => {
    if (!room) return;
    const check = removeGroupMember(room.botIds, botId);
    if (!check.ok) {
      setError(t(issueKey(check.code)));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = (await api(`/api/bot-rooms/${room.id}/members/${encodeURIComponent(botId)}`, { method: 'DELETE' })) as {
        room: Room;
      };
      await changeMembers(data.room);
    } catch {
      setError(t('play.group.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!room) return;
    const submitted = text.trim();
    if (!submitted) return;
    setText('');
    setBusy(true);
    setError('');
    try {
      const result = (await api(
        `/api/bot-rooms/${room.id}/messages`,
        jsonBody({
          text: submitted,
          idempotencyKey: crypto.randomUUID()
        })
      )) as { message?: RoomMessage };
      if (result.message && !messagesRef.current.some((item) => item.id === result.message!.id)) {
        const next = [...messagesRef.current, result.message];
        messagesRef.current = next;
        setMessages(next);
      }
      await loadRoom(false);
    } catch {
      setText(submitted);
      setError(t('play.group.sendFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="play-main chat-panel" data-testid="play-group-chat">
      <header className="chat-panel-header">
        <div className="chat-panel-header__text">
          <h2 className="chat-panel-title">{room?.title ?? t('play.group.badge')}</h2>
        </div>
      </header>
      <div className="play-group-members">
        <div className="play-group-member-row">
          <span className="play-group-badge">{t('play.group.badge')}</span>
          {room?.botIds.map((id) => {
            const description = descriptionOf(id);
            return (
              <span key={id} className="play-group-member">
                <span className="play-group-member__identity">
                  <span>{nameOf(id)}</span>
                  {description ? (
                    <span className="play-group-member__desc" title={description}>
                      {description}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || !room || room.botIds.length <= 2}
                  aria-label={t('play.group.removeAria', { name: nameOf(id) })}
                  onClick={() => void removeMember(id)}
                >
                  {t('play.group.remove')}
                </button>
              </span>
            );
          })}
        </div>
        <div className="play-group-add">
          <select aria-label={t('play.group.addMember')} value={addId} onChange={(event) => setAddId(event.target.value)}>
            <option value="">{t('play.group.addMember')}</option>
            {available.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !addId} onClick={() => void addMember()}>
            {t('play.group.add')}
          </button>
        </div>
        {room && room.botIds.length <= 2 ? <p className="play-group-hint">{t('play.group.keepTwo')}</p> : null}
        {error ? <p className="play-group-error">{error}</p> : null}
      </div>
      <div className="chat-panel-body">
        <div className="chat-feed-shell">
          <div className="chat-feed" role="log" ref={feedRef} aria-label={t('play.group.transcript')}>
            <div className="chat-feed__track">
              {loadError ? <p className="play-group-error">{t('play.group.loadFailed')}</p> : null}
              {!loadError && messages.length === 0 ? <p className="play-group-hint">{t('play.group.noMessages')}</p> : null}
              {messages.map((message) => {
                const name = senderName(message, bots, t('play.me'));
                const liveId = liveSpeakerId(turns);
                const lastFromLive = [...messages].reverse().find((item) => item.sender.type === 'bot' && item.sender.id === liveId);
                const mood = message.sender.type === 'bot' && message.id === lastFromLive?.id ? 'speaking' : 'idle';
                const count = message.attachmentIds?.length ?? 0;
                return (
                  <GroupTurn
                    key={message.id}
                    message={message}
                    name={name}
                    mood={mood}
                    attachmentLabel={count > 0 ? t('play.group.attachmentCount', { count }) : undefined}
                  />
                );
              })}
              {speaking ? <p className="play-group-hint">{t('play.group.membersSpeaking')}</p> : null}
              {cursor != null ? (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadRoom(true)}>
                  {t('play.group.older')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <form
          className="play-group-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {mentionOpen ? (
            <ul id="play-group-mentions" className="play-group-mentions" role="listbox" aria-label={t('play.group.mentionList')}>
              {mentionOptions.length === 0 ? (
                <li className="play-group-mentions__empty">{t('play.group.mentionEmpty')}</li>
              ) : (
                mentionOptions.map((option, index) => {
                  const selected = option.id === activeMention?.id;
                  return (
                    <li key={option.id} id={`play-group-mention-${option.id}`} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        className={`play-group-mentions__option${selected ? ' is-active' : ''}`}
                        data-testid="play-group-mention"
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setMentionIndex(index)}
                        onClick={() => chooseMention(option.name)}
                      >
                        <BotFace name={option.name} size="sm" />
                        <span>{option.name}</span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            placeholder={t('play.group.placeholder')}
            aria-label={t('play.group.placeholder')}
            aria-autocomplete="list"
            aria-controls="play-group-mentions"
            aria-expanded={mentionOpen}
            aria-activedescendant={mentionOpen && activeMention ? `play-group-mention-${activeMention.id}` : undefined}
            disabled={!room || room.status !== 'active' || busy}
            onChange={(event) => {
              setText(event.target.value);
              syncCaret(event.currentTarget);
            }}
            onClick={(event) => syncCaret(event.currentTarget)}
            onKeyUp={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === 'Escape') return;
              syncCaret(event.currentTarget);
            }}
            onKeyDown={(event) => {
              const ime = event.nativeEvent.isComposing || event.keyCode === 229;
              if (mentionOpen && event.key === 'ArrowDown' && mentionOptions.length) {
                event.preventDefault();
                setMentionIndex((index) => (index + 1) % mentionOptions.length);
                return;
              }
              if (mentionOpen && event.key === 'ArrowUp' && mentionOptions.length) {
                event.preventDefault();
                setMentionIndex((index) => (index - 1 + mentionOptions.length) % mentionOptions.length);
                return;
              }
              if (mentionOpen && event.key === 'Escape') {
                event.preventDefault();
                setMentionDismissed(mentionKey);
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey || ime) return;
              if (mentionOpen && activeMention) {
                event.preventDefault();
                chooseMention(activeMention.name);
                return;
              }
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            data-testid="play-group-send"
            disabled={busy || !room || room.status !== 'active' || !text.trim()}
          >
            {busy ? t('play.group.sending') : t('play.group.send')}
          </button>
        </form>
        {room && room.status !== 'active' ? <p className="play-group-hint">{t('play.group.paused')}</p> : null}
      </div>
    </div>
  );
}

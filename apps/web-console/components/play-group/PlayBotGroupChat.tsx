'use client';

import { useEffect, useRef, useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { mergeHistoryWindow } from '@/lib/history-window';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { sameData } from '@/lib/same-data';
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
import { MarkdownHtml } from '../MarkdownHtml';
import { BotFace } from '../BotFace';
import { useBotWorkStates } from '../bot-work/BotWorkState';
import { MODEL_PROVIDERS_CHANGED_EVENT } from '@/lib/model-providers';
import { groupComposerCommand, runGroupComposerCommand, groupMessageMood, roomComposerDisabled, roomDefaultModelLabel, roomMemberModelLabel, roomHistoryUrl } from '@/lib/group-chat-view';
import type { RoomModelConfiguration } from '@/lib/room-models';
import { RoomSharedContextEditor } from './RoomSharedContextEditor';
import './play-group.css';
import '../bot-work/bot-work.css';
import { BotRooms } from '../bot-work/BotRooms';
import { ComposerContextChips, ComposerMessageContext, ComposerNotice, useComposerFileDrop } from '../ComposerContext';
import { composerClassName, contextSubmission, limitContextSources, contextSourcesBody, contextSourcesForSend, withContextIds, type PendingContextSource } from '@/lib/composer-context';

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
  contextSources?: unknown;
  sender: { type: 'user' | 'bot'; id: string; name: string };
};

type RoomTurn = { id: string; status: string; botIds?: string[]; mentionedBotIds?: string[]; cursor?: number; terminationReason?: string };

function RoomReplyFailure({ turn }: { turn?: RoomTurn }) {
  const { t } = useI18n();
  if (turn?.status !== 'failed') return null;
  return <p role="alert" className="play-group-error">{t('play.group.replyFailed')}</p>;
}

function liveSpeakerId(turns: readonly RoomTurn[]): string {
  const live = turns.find((turn) => turn.status === 'running');
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
          <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={message.text} />
          <ComposerMessageContext role={kind} message={message} />
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
  const workStates = useBotWorkStates();
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => setShowSettings(false), [roomId]);
  const [models,setModels] = useState<RoomModelConfiguration|null>(null);
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
  const [pendingContext, setPendingContext] = useState<PendingContextSource[]>([]);
  const [contextNotice, setContextNotice] = useState('');
  const [loadError, setLoadError] = useState(false);
  const messagesRef = useRef<RoomMessage[]>([]);
  const roomIdRef = useRef(roomId);
  const feedRef = useRef<HTMLDivElement>(null);
  roomIdRef.current = roomId;

  const commitMessages = (next: RoomMessage[]) => {
    if (sameData(messagesRef.current, next)) return;
    messagesRef.current = next;
    setMessages(next);
  };

  const acceptMessage = (message?: RoomMessage) => {
    if (!message) return;
    if (messagesRef.current.some(item => item.id === message.id)) return;
    commitMessages([...messagesRef.current, message]);
  };

  const applyHistory = (
    page: { messages: RoomMessage[]; hasMore: boolean; nextCursor: number | null },
    older: boolean
  ) => {
    const firstLoad = messagesRef.current.length === 0;
    const next = older
      ? [...page.messages, ...messagesRef.current]
      : mergeHistoryWindow(messagesRef.current, page.messages, true).messages;
    commitMessages(next);
    if (older || firstLoad) setCursor(page.hasMore ? page.nextCursor : null);
  };

  const loadRoom = async (older = false) => {
    const id = roomId;
    const historyUrl = roomHistoryUrl(id, older, cursor);
    const [history, turnData, current] = (await Promise.all([
      api(historyUrl),
      api(`/api/bot-rooms/${id}/turns`),
      api(`/api/bot-rooms/${id}`)
    ])) as [
      { messages: RoomMessage[]; hasMore: boolean; nextCursor: number | null },
      { turns: RoomTurn[] },
      { room: Room; models?: RoomModelConfiguration }
    ];
    if (roomIdRef.current !== id) return;
    applyHistory(history, older);
    const turns = Array.isArray(turnData.turns) ? turnData.turns : [];
    setTurns((prev) => (sameData(prev, turns) ? prev : turns));
    setRoom((prev) => (sameData(prev, current.room) ? prev : current.room));
    const models = current.models ?? null;
    setModels((prev) => (sameData(prev, models) ? prev : models));
    setLoadError(false);
  };

  useEffect(() => {
    messagesRef.current = [];
    setMessages([]);
    setRoom(null);
    setModels(null);
    setTurns([]);
    setCursor(null);
    setText('');
    setPendingContext([]);
    setContextNotice('');
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
    const onModelsChanged=()=>refresh(false);
    window.addEventListener(MODEL_PROVIDERS_CHANGED_EVENT,onModelsChanged);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(MODEL_PROVIDERS_CHANGED_EVENT,onModelsChanged);
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

  const contextDrop = useComposerFileDrop((sources, truncated) => {
    if (sources.length === 0) return;
    const result = limitContextSources([...pendingContext, ...withContextIds(sources)]);
    setPendingContext(result.sources);
    if (truncated || result.truncated) setContextNotice(t('play.composer.contextTruncated'));
  }, roomId);

  const removePendingContext = (id: string) => {
    setPendingContext((current) => current.filter((item) => item.id !== id));
  };

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
    const contextSources = contextSourcesForSend(pendingContext);
    const contextFields = contextSourcesBody(contextSources);
    const submission = contextSubmission(submitted, contextSources);
    if (!submission.hasContent) return;
    const textSnapshot = text;
    const contextSnapshot = pendingContext;
    setText('');
    setPendingContext([]);
    setContextNotice('');
    setBusy(true);
    setError('');
    try {
      const result = (await api(
        `/api/bot-rooms/${room.id}/messages`,
        jsonBody({
          text: submission.message,
          idempotencyKey: crypto.randomUUID(),
          ...contextFields
        })
      )) as { message?: RoomMessage };
      acceptMessage(result.message);
      // Acceptance is durable even when the subsequent read fails. Do not
      // restore an accepted message into the composer and invite duplicates.
      await loadRoom(false).catch(() => setLoadError(true));
    } catch {
      setText(textSnapshot);
      setPendingContext(contextSnapshot);
      setError(t('play.group.sendFailed'));
    } finally {
      setBusy(false);
    }
  };

  const liveId = liveSpeakerId(turns);
  const lastFromLive = [...messages].reverse().find((item) => item.sender.type === 'bot' && item.sender.id === liveId);

  return (
    <div className="play-main chat-panel" data-testid="play-group-chat">
      <header className="chat-panel-header">
        <div className="chat-panel-header__text">
          <h2 className="chat-panel-title">{room?.title ?? t('play.group.badge')}</h2>
          <div className="play-group-model-default" data-testid="room-default-model">
            <span>{t('play.groupModel.defaultLabel')}: {roomDefaultModelLabel(models, t)}</span>
            <a href="#/settings/models">{t('play.groupModel.settings')}</a>
          </div>
          <p className="play-group-model-hint">{t('play.groupModel.priorityHint')}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showSettings} onClick={() => setShowSettings(value => !value)}>{t('play.groupSettings.title')}</button>
      </header>
      {showSettings && <div className="play-group-settings" data-testid="room-settings"><BotRooms key={roomId} bots={[...bots]} selectedRoomId={roomId} /></div>}
      <div className="play-group-members">
        <div className="play-group-member-row">
          <span className="play-group-badge">{t('play.group.badge')}</span>
          {room?.botIds.map((id) => {
            const description = descriptionOf(id);
            return (
              <span key={id} className="play-group-member">
                <BotFace name={nameOf(id)} mood={workStates[id]>0?'thinking':'idle'} size="sm" testId={`room-member-face-${id}`} />
                <span className="play-group-member__identity">
                  <span>{nameOf(id)}</span>
                  {description ? (
                    <span className="play-group-member__desc" title={description}>
                      {description}
                    </span>
                  ) : null}
                  <span className="play-group-member__model" data-testid={`room-member-model-${id}`}>
                    {roomMemberModelLabel(models, id, t)}
                  </span>
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
        <RoomReplyFailure turn={turns.at(-1)} />
        {room ? <RoomSharedContextEditor roomId={room.id} /> : null}
      </div>
      <div className="chat-panel-body">
        <div className="chat-feed-shell">
          <div className="chat-feed" role="log" ref={feedRef} aria-label={t('play.group.transcript')}>
            <div className="chat-feed__track">
              {loadError ? <p className="play-group-error">{t('play.group.loadFailed')}</p> : null}
              {!loadError && messages.length === 0 ? <p className="play-group-hint">{t('play.group.noMessages')}</p> : null}
              {messages.map((message) => {
                const name = senderName(message, bots, t('play.me'));
                const mood = groupMessageMood(message, lastFromLive?.id, workStates);
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
          className={composerClassName('play-group-composer', contextDrop.over)}
          data-testid="composer-drop-target"
          data-surface="group"
          onDragEnter={contextDrop.onDragEnter}
          onDragOver={contextDrop.onDragOver}
          onDragLeave={contextDrop.onDragLeave}
          onDrop={contextDrop.onDrop}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <ComposerContextChips items={pendingContext} onRemove={removePendingContext} />
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
              const command = groupComposerCommand(event.key, event.shiftKey, event.nativeEvent.isComposing || event.keyCode === 229, mentionOpen, mentionOptions.length, !!activeMention);
              if (command === 'none') return;
              event.preventDefault();
              runGroupComposerCommand(command, {
                next: () => setMentionIndex(index => (index + 1) % mentionOptions.length),
                previous: () => setMentionIndex(index => (index - 1 + mentionOptions.length) % mentionOptions.length),
                dismiss: () => setMentionDismissed(mentionKey),
                choose: () => chooseMention(activeMention!.name),
                send: () => event.currentTarget.form?.requestSubmit()
              });
            }}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            data-testid="play-group-send"
            disabled={roomComposerDisabled(room, busy, text, pendingContext.length > 0)}
          >
            {busy ? t('play.group.sending') : t('play.group.send')}
          </button>
        </form>
        <ComposerNotice text={contextNotice} />
        {room && room.status !== 'active' ? <p className="play-group-hint">{t('play.group.paused')}</p> : null}
      </div>
    </div>
  );
}

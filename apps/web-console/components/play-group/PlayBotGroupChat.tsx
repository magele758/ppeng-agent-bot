'use client';

import { RoomCollaborationHistory, type CollaborationTurn } from './RoomCollaborationHistory';

import { useEffect, useRef, useState } from 'react';
import type { BotInfo } from '@/lib/types';
import { api } from '@/lib/api';
import { mergeHistoryWindow, loadEarlierCursorAfterReset, prependHistoryPage } from '@/lib/history-window';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { sameData } from '@/lib/same-data';
import {
  BOT_GROUPS_CHANGED_EVENT,
  activeMentionQuery,
  addGroupMember,
  groupSpeakBudget,
  insertMention,
  removeGroupMember,
  type GroupMemberCode
} from '@/lib/bot-group';
import { stripVisibleClockMarks } from '@/lib/visible-clock';
import { MarkdownHtml } from '../MarkdownHtml';
import { BotFace } from '../BotFace';
import { useBotWorkStates } from '../bot-work/BotWorkState';
import { MODEL_PROVIDERS_CHANGED_EVENT } from '@/lib/model-providers';
import { groupComposerCommand, runGroupComposerCommand, groupMessageMood, roomComposerDisabled, roomHistoryUrl } from '@/lib/group-chat-view';
import type { RoomModelConfiguration } from '@/lib/room-models';
import { RoomSharedContextEditor } from './RoomSharedContextEditor';
import { RoomGoalBar } from './RoomGoalBar';
import { RoomMemberDrawer } from './RoomMemberDrawer';
import {
  memberNeedsPerson,
  mentionChoices,
  normalizeFunctionalGroups,
  pendingApprovalId,
  readRoomGoal,
  roomApprovalMode,
  showInlineApprove,
  speakingBotIds,
  uniqueMemberIds,
  type FunctionalGroupRef,
  type MentionChoice,
  type RoomApprovalMode
} from './room-console';
import './play-group.css';
import '../bot-work/bot-work.css';
import { BotRooms } from '../bot-work/BotRooms';
import { ComposerContextChips, ComposerMessageContext, ComposerNotice, ignoreComposerDrop, usePendingComposerContext } from '../ComposerContext';
import { BotReplyQuoteAction, ComposerReplyQuote, MessageReplyQuote } from '../ReplyQuote';
import { composerClassName, contextSubmission, contextSourcesBody, contextSourcesForSend } from '@/lib/composer-context';
import { attachSentReply, keepLocalReplyTo, readStoredReplyTo, withReplyTo, type ReplyQuote } from '@/lib/reply-quote';

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
  replyTo?: unknown;
  sender: { type: 'user' | 'bot'; id: string; name: string };
};

type RoomTurn = CollaborationTurn & { id: string; status: string; botIds?: string[]; mentionedBotIds?: string[]; cursor?: number; terminationReason?: string };

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
  attachmentLabel,
  onQuote,
  quotedName
}: {
  message: RoomMessage;
  name: string;
  mood: 'idle' | 'speaking';
  attachmentLabel?: string;
  onQuote: (quote: ReplyQuote) => void;
  quotedName: string;
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
        <div className="chat-turn__label">
          {name}
          <BotReplyQuoteAction
            reply={{
              messageId: message.id,
              botId: message.sender.id,
              botName: name,
              text: stripVisibleClockMarks(message.text),
              author: user ? 'user' : 'bot'
            }}
            onQuote={onQuote}
          />
        </div>
        <div className="chat-bubble">
          {user ? <MessageReplyQuote replyTo={readStoredReplyTo(message)} botName={quotedName} /> : null}
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

function mentionDetail(option: MentionChoice, groupCount: (count: number) => string): string {
  switch (option.kind) {
    case 'group':
      return groupCount(option.count);
    case 'bot':
      return option.detail;
    default: {
      const exhaustive: never = option.kind;
      return exhaustive;
    }
  }
}

export function PlayBotGroupChat({ roomId, bots }: { roomId: string; bots: readonly BotInfo[] }) {
  const { t } = useI18n();
  const workStates = useBotWorkStates();
  const [showSettings, setShowSettings] = useState(false);
  const [groups, setGroups] = useState<FunctionalGroupRef[]>([]);
  const [approvalMode, setApprovalMode] = useState<RoomApprovalMode>('private');
  const [goalBusy, setGoalBusy] = useState(false);
  useEffect(() => {
    setShowSettings(false);
  }, [roomId]);
  const [models,setModels] = useState<RoomModelConfiguration|null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [turns, setTurns] = useState<RoomTurn[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [replyQuote, setReplyQuote] = useState<ReplyQuote | null>(null);
  useEffect(() => setReplyQuote(null), [roomId]);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [contextNotice, setContextNotice] = useState('');
  const { pendingContext, setPendingContext } = usePendingComposerContext(() => {
    setContextNotice(t('play.composer.contextTruncated'));
  });
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
    const merged = older ? null : mergeHistoryWindow(messagesRef.current, page.messages, true);
    const next = merged?.messages ?? prependHistoryPage(messagesRef.current, page.messages);
    commitMessages(keepLocalReplyTo(messagesRef.current, next));
    if (merged?.reset) setCursor(loadEarlierCursorAfterReset(next, page.hasMore, page.nextCursor));
    else if (older || firstLoad) setCursor(page.hasMore ? page.nextCursor : null);
  };

  const loadRoom = async (older = false) => {
    const id = roomId;
    const historyUrl = roomHistoryUrl(id, older, cursor);
    const [history, turnData, current, groupData, settingsData] = (await Promise.all([
      api(historyUrl),
      api(`/api/bot-rooms/${id}/turns`),
      api(`/api/bot-rooms/${id}`),
      api('/api/bot-functional-groups').catch(() => null),
      api('/api/bot-rooms/settings').catch(() => null)
    ])) as [
      { messages: RoomMessage[]; hasMore: boolean; nextCursor: number | null },
      { turns: RoomTurn[] },
      { room: Room; models?: RoomModelConfiguration },
      unknown,
      unknown
    ];
    if (roomIdRef.current !== id) return;
    applyHistory(history, older);
    const turns = Array.isArray(turnData.turns) ? turnData.turns : [];
    setTurns((prev) => (sameData(prev, turns) ? prev : turns));
    setRoom((prev) => (sameData(prev, current.room) ? prev : current.room));
    const models = current.models ?? null;
    setModels((prev) => (sameData(prev, models) ? prev : models));
    if (groupData) {
      const nextGroups = normalizeFunctionalGroups(groupData);
      setGroups((prev) => (sameData(prev, nextGroups) ? prev : nextGroups));
    }
    if (settingsData && typeof settingsData === 'object') {
      const nextMode = roomApprovalMode((settingsData as { settings?: unknown }).settings);
      setApprovalMode((prev) => (prev === nextMode ? prev : nextMode));
    }
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
  const known = new Set(bots.map((bot) => bot.id));
  const memberIds = uniqueMemberIds(room?.botIds ?? []);
  const workingIds = memberIds.filter(id => workStates[id] > 0);
  const speaking = turns.some((turn) => turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_approval');
  const speakingIds = speakingBotIds(turns);
  const speakingNames = speakingIds.map(nameOf).join(t('play.group.nameSeparator'));
  const mentionRoster = memberIds.map((id) => {
    const bot = bots.find((item) => item.id === id);
    return { id, name: bot?.name ?? id, title: bot?.title ?? '', description: bot?.description ?? '' };
  });
  const mention = activeMentionQuery(text, caret);
  const mentionOptions = mention ? mentionChoices(mentionRoster, [], mention.query, new Set(memberIds)) : [];
  const goal = readRoomGoal(room);
  const approveVisible = showInlineApprove(approvalMode, memberNeedsPerson(turns));
  const mentionKey = mention ? `${mention.start}:${mention.query}` : '';
  const mentionOpen = Boolean(mention && mentionKey !== mentionDismissed && room?.status === 'active' && !busy);
  const activeMention = mentionOptions[Math.min(mentionIndex, Math.max(mentionOptions.length - 1, 0))];


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
    window.dispatchEvent(new Event(BOT_GROUPS_CHANGED_EVENT));
  };

  const addMember = async (botId: string) => {
    if (!room || !botId) return;
    const check = addGroupMember(room.botIds, botId, known);
    if (!check.ok) {
      setError(t(issueKey(check.code)));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = (await api(`/api/bot-rooms/${room.id}/members`, jsonBody({ botId }))) as { room: Room };
      await changeMembers(data.room);
    } catch {
      setError(t('play.group.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (botId: string) => {
    if (!room || !botId || botId === room.hostBotId) return;
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

  const addFunctionalGroup = async (groupId: string) => {
    if (!room || !groupId) return;
    setBusy(true);
    setError('');
    try {
      const data = (await api(`/api/bot-rooms/${room.id}/members`, jsonBody({ groupId }))) as { room: Room };
      await changeMembers(data.room);
    } catch {
      setError(t('play.group.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const runGoalAction = async (action: 'pause' | 'cancel' | 'amend', constraint?: string) => {
    const current = readRoomGoal(room);
    if (!room || !current?.id) return;
    setGoalBusy(true);
    setError('');
    try {
      await api(`/api/bot-rooms/${room.id}/goals/${encodeURIComponent(current.id)}/actions`, jsonBody({
        action,
        ...(constraint ? { constraint } : {})
      }));
      await loadRoom(false);
    } catch {
      setError(t('play.roomGoal.actionFailed'));
    } finally {
      setGoalBusy(false);
    }
  };

  const approveInline = async () => {
    const approvalId = pendingApprovalId(turns);
    if (!room || !approvalId) {
      setError(t('play.group.approveUnavailable'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/bot-rooms/${room.id}/approvals/${encodeURIComponent(approvalId)}`, jsonBody({ action: 'approve' }));
      await loadRoom(false);
    } catch {
      setError(t('play.group.approveUnavailable'));
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
    const quoteSnapshot = replyQuote;
    setText('');
    setPendingContext([]);
    setReplyQuote(null);
    setContextNotice('');
    setBusy(true);
    setError('');
    try {
      const result = (await api(
        `/api/bot-rooms/${room.id}/messages`,
        jsonBody(withReplyTo({
          text: submission.message,
          idempotencyKey: crypto.randomUUID(),
          ...contextFields
        }, quoteSnapshot))
      )) as { message?: RoomMessage };
      acceptMessage(result.message ? attachSentReply(result.message, quoteSnapshot) : undefined);
      // Acceptance is durable even when the subsequent read fails. Do not
      // restore an accepted message into the composer and invite duplicates.
      await loadRoom(false).catch(() => setLoadError(true));
    } catch {
      setText(textSnapshot);
      setPendingContext(contextSnapshot);
      setReplyQuote(quoteSnapshot);
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
        </div>
        <div className="play-group-header-actions">
          <a className="btn btn-ghost btn-sm" href="#/settings/models" data-testid="room-default-model">{t('play.groupModel.settings')}</a>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showSettings} onClick={() => setShowSettings(value => !value)}>{t('play.groupSettings.title')}</button>
        </div>
      </header>
      <RoomGoalBar
        goal={goal}
        busy={goalBusy}
        onPause={() => void runGoalAction('pause')}
        onCancel={() => void runGoalAction('cancel')}
        onAmend={(constraint) => void runGoalAction('amend', constraint)}
      />
      {workingIds.length > 0 ? (
        <div className="play-group-working" data-testid="room-working-members" aria-label={t('play.group.workingMembers')}>
          {workingIds.map(id => (
            <span key={id} className="play-group-working__member" title={nameOf(id)}>
              <BotFace name={nameOf(id)} mood="thinking" size="sm" testId={`room-working-face-${id}`} />
              <span className="play-group-working__name">{nameOf(id)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {showSettings ? (
        <div className="play-group-settings" data-testid="room-settings">
          <BotRooms key={roomId} bots={[...bots]} selectedRoomId={roomId} memberEditor={false} />
          {room ? <section className="play-group-settings-members" aria-label={t('play.group.membersDrawer')}>
            <h3>{t('play.group.membersDrawer')}</h3>
            <RoomMemberDrawer
              memberIds={memberIds}
              bots={[...bots]}
              groups={groups}
              hostId={room.hostBotId}
              speakingIds={speakingIds}
              models={models}
              faceMood={(id) => (workStates[id] > 0 ? 'thinking' : 'idle')}
              busy={busy}
              error={error}
              onAddMember={(botId) => void addMember(botId)}
              onRemoveMember={(botId) => void removeMember(botId)}
              onAddGroup={(groupId) => void addFunctionalGroup(groupId)}
            />
            <RoomSharedContextEditor roomId={room.id} />
          </section> : null}
        </div>
      ) : null}
      {!showSettings && error ? <p className="play-group-error">{error}</p> : null}
      <RoomReplyFailure turn={turns.at(-1)} />
      <RoomCollaborationHistory turns={turns} names={new Map(bots.map(bot => [bot.id, bot.name]))} />
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
                const storedReply = readStoredReplyTo(message);
                const quotedName = storedReply
                  ? bots.find((bot) => bot.id === storedReply.botId)?.name ?? storedReply.botId
                  : '';
                return (
                  <GroupTurn
                    key={message.id}
                    message={message}
                    name={name}
                    mood={mood}
                    attachmentLabel={count > 0 ? t('play.group.attachmentCount', { count }) : undefined}
                    onQuote={setReplyQuote}
                    quotedName={quotedName}
                  />
                );
              })}
              {speakingNames ? <p className="play-group-speaking" data-testid="play-group-speaking">{t('play.group.speakingNow', { names: speakingNames })}</p> : null}
              {speaking && !speakingNames ? <p className="play-group-hint">{t('play.group.membersSpeaking')}</p> : null}
              {approveVisible ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="play-group-approve"
                  aria-label={t('play.group.approveAria')}
                  disabled={busy}
                  onClick={() => void approveInline()}
                >
                  {t('play.group.approve')}
                </button>
              ) : null}
              {cursor != null ? (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void loadRoom(true)}>
                  {t('play.group.older')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <form
          className={composerClassName('play-group-composer')}
          data-testid="composer-drop-target"
          data-surface="group"
          onDragOver={ignoreComposerDrop}
          onDrop={ignoreComposerDrop}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <ComposerContextChips items={pendingContext} onRemove={removePendingContext} />
          <ComposerReplyQuote quote={replyQuote} surface="group" onCancel={() => setReplyQuote(null)} />
          {mentionOpen ? (
            <ul id="play-group-mentions" className="play-group-mentions" role="listbox" aria-label={t('play.group.mentionList')}>
              {mentionOptions.length === 0 ? (
                <li className="play-group-mentions__empty">{t('play.group.mentionEmpty')}</li>
              ) : (
                mentionOptions.map((option, index) => {
                  const selected = option.id === activeMention?.id;
                  const detail = mentionDetail(option, (count) => t('play.group.mentionGroupCount', { count }));
                  return (
                    <li key={option.id} id={`play-group-mention-${option.id}`} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        className={`play-group-mentions__option${selected ? ' is-active' : ''}`}
                        data-testid="play-group-mention"
                        data-kind={option.kind}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setMentionIndex(index)}
                        onClick={() => chooseMention(option.insert)}
                      >
                        <BotFace name={option.name} size="sm" />
                        <span>{option.name}</span>
                        {detail ? <span className="play-group-mentions__detail">{detail}</span> : null}
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
                choose: () => chooseMention(activeMention!.insert),
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

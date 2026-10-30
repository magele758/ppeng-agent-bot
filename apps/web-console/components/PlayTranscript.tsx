'use client';

import { useMemo, type ReactNode } from 'react';
import type { ApprovalItem, ChatMessage } from '@/lib/types';
import { anchorApprovals } from '@/lib/approval-feed';
import { messageHasStructuredParts, msgPartsToText, normalizedRole } from '@/lib/chat-utils';
import { readMessageSessionId } from '@/lib/goal-update-notice';
import { omitStreamTextSavedOnTurn } from '@/lib/history-window';
import { continuedAssistantIndexes } from '@/lib/assistant-label-run';
import { buildFeedSlots, steerStreamPlacement, type FeedSlot } from '@/lib/feed-window';
import { rowsForSessionBrief } from '@/lib/session-brief';
import { SessionBriefDisclosure } from './SessionBriefDisclosure';
import { formatHash } from '@/lib/nav';
import { useI18n } from '@/lib/i18n';
import type { ReplyQuote } from '@/lib/reply-quote';
import { indexResolvedToolCallIds, indexToolCalls } from '@/lib/tool-io';
import { sliceConversationTurns } from '@/lib/turn-feed-stats';
import { placeChildTaskEntries, type ChildTaskStreamEntry } from '@/lib/bot-child-task-stream';
import { ApprovalBanner } from './ApprovalBanner';
import { BotChildTaskStreamEntry } from './BotChildTaskStreamEntry';
import { ChatFeedWindow } from './ChatFeedWindow';
import { ContinuedAssistantContext, ChatTurnIfVisible, ChatTurnPlain, ChatTurnStreaming } from './ChatTurns';
import { SurfaceContextProvider } from './a2ui/SurfaceContext';
import { SkillOperationCards } from './SkillOperationCards';
import { SkillCaptureCards } from './SkillCaptureCards';
import type { usePlayChat } from './usePlayChat';

type Chat = ReturnType<typeof usePlayChat>;
type Calls = ReturnType<typeof indexToolCalls>;
type Anchors = ReturnType<typeof anchorApprovals<ApprovalItem>>;

export function PlayTranscript(props: {
  layoutKey?: string;
  chat: Chat;
  selectedSessionId: string | null;
  sessionApprovals: ApprovalItem[];
  turnFeedStatLines: Array<string | null>;
  botSurface: boolean;
  footer: ReactNode;
  onOpenModelSetup: () => void;
  onNewSession: () => void;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
  replyQuoteBot?: { id: string; name: string } | null;
  onQuoteReply?: (quote: ReplyQuote) => void;
  childTaskEntries?: readonly ChildTaskStreamEntry[];
  onOpenChildTask?: (sessionId: string) => void;
  sessionBrief?: boolean;
}) {
  const view = transcriptView(props.chat, props.sessionApprovals, props.turnFeedStatLines, Boolean(props.selectedSessionId), props.childTaskEntries ?? []);
  const brief = Boolean(props.sessionBrief) && !props.chat.showModelView;
  const slots = rowsForSessionBrief(brief, view.slots, view.messages).map((row) =>
    row.type === 'slot' ? row.slot : { key: row.key, kind: 'brief-note' as const, briefCount: row.count, folded: row.slots }
  );
  const continued = useContinuedAssistant(slots, view);
  return (
    <SurfaceContextProvider messages={props.chat.displayMessages}>
      <ContinuedAssistantContext.Provider value={continued}>
      <ChatFeedWindow
        layoutKey={props.layoutKey}
        scrollerRef={props.chat.playMessagesRef}
        slots={slots}
        renderSlot={(slot) => renderTranscriptSlot(slot, view, props, brief)}
        stickToBottomRef={props.chat.playStickToBottomRef}
        scrollIntentRef={props.chat.feedScrollIntentRef}
        revision={props.chat.feedRevision}
        hasOlder={props.chat.historyCursor != null}
        olderLoading={props.chat.historyLoading}
        onStickScroll={props.chat.handlePlayMessagesScroll}
        onRequestOlder={(reason) => void props.chat.loadOlderHistory(reason)}
        header={<>{brief ? <BriefBanner /> : null}<FeedHeader view={view} {...props} /></>}
        footer={<>{props.selectedSessionId ? <SkillCaptureCards
          key={props.selectedSessionId}
          sessionId={props.selectedSessionId}
          onLayoutChange={() => {
            const feed = props.chat.playMessagesRef.current;
            if (feed && props.chat.playStickToBottomRef.current) feed.scrollTop = feed.scrollHeight;
          }}
        /> : null}{props.selectedSessionId ? <SkillOperationCards key={'operations-'+props.selectedSessionId} sessionId={props.selectedSessionId} onLayoutChange={() => { const feed = props.chat.playMessagesRef.current; if (feed && props.chat.playStickToBottomRef.current) feed.scrollTop = feed.scrollHeight; }}/> : null}{props.footer}</>}
      />
      </ContinuedAssistantContext.Provider>
    </SurfaceContextProvider>
  );
}

function roleAt(messages: ChatMessage[], i: number): string | undefined {
  const m = messages[i];
  return m ? normalizedRole(m) : undefined;
}

function useContinuedAssistant(slots: FeedSlot[], view: TranscriptModel): ReadonlySet<number> {
  return useMemo(() => continuedAssistantIndexes(slots, (i) => roleAt(view.messages, i)), [slots, view.messages]);
}

function FeedHeader(props: {
  view: TranscriptModel;
  chat: Chat;
  botSurface: boolean;
  sessionApprovals: ApprovalItem[];
  onOpenModelSetup: () => void;
  onNewSession: () => void;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
}) {
  return (
    <>
      <ModelBanner chat={props.chat} />
      <HistoryStatus chat={props.chat} />
      <TranscriptEmpty {...props} />
    </>
  );
}

function BriefBanner() {
  const { t } = useI18n();
  return <p className="chat-process-note" role="status">{t('play.chrome.sessionBriefBanner')}</p>;
}

function ProcessNote({ slot, view, props }: { slot: FeedSlot; view: TranscriptModel; props: Parameters<typeof renderTranscriptSlot>[2] }) {
  const { t } = useI18n();
  const folded = slot.folded ?? [];
  if (folded.length === 0) return null;
  return (
    <SessionBriefDisclosure noteKey={slot.key} label={t('play.turns.processNote', { count: folded.length })} title={t('play.turns.processNoteTitle')}>
      {folded.map((foldedSlot) => (
        <div key={foldedSlot.key}>{renderTranscriptSlot(foldedSlot, view, props, false)}</div>
      ))}
    </SessionBriefDisclosure>
  );
}

function ModelBanner({ chat }: { chat: Chat }) {
  const { t } = useI18n();
  if (!chat.showModelView) return null;
  return (
    <div className="model-view-banner" role="status">
      {t('play.chrome.modelViewBanner', { policy: chat.modelViewPayload?.policy ?? '—' })}
      {bannerStats(t, chat.modelViewPayload?.stats.collapsed, chat.modelViewPayload?.stats.charsSaved)}
      <span className="muted">{t('play.chrome.storedFull')}</span>
    </div>
  );
}

function bannerStats(t: ReturnType<typeof useI18n>['t'], collapsed?: number, saved?: number): string {
  if (collapsed == null || saved == null) return '';
  return t('play.chrome.modelViewStats', { collapsed, saved });
}

function HistoryStatus({ chat }: { chat: Chat }) {
  const { t } = useI18n();
  if (chat.historyCursor == null || (!chat.historyLoading && !chat.historyError)) return null;
  return (
    <div className="chat-feed__older" role="status">
      {chat.historyLoading ? t('play.history.loading') : <>
        <span>{t('play.history.failed')}</span>
        <button type="button" className="btn btn-ghost btn-sm" data-testid="feed-retry-older"
          onClick={() => void chat.loadOlderHistory('scroll')}>
          {t('play.history.retry')}
        </button>
      </>}
    </div>
  );
}

function TranscriptEmpty(props: {
  view: TranscriptModel;
  botSurface: boolean;
  sessionApprovals: ApprovalItem[];
  onOpenModelSetup: () => void;
  onNewSession: () => void;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
  chat: Chat;
}) {
  if (!props.view.empty) return null;
  if (!props.view.selected) return <UnselectedEmpty bot={props.botSurface} setup={props.chat.needsModelSetup} onOpen={props.onOpenModelSetup} onNew={props.onNewSession} />;
  return (
    <>
      <NoMessagesEmpty setup={props.chat.needsModelSetup} onOpen={props.onOpenModelSetup} />
      <PendingApprovals approvals={props.sessionApprovals} onDone={props.onApprovalsChanged} onAttach={props.onAttachStream} />
    </>
  );
}

function UnselectedEmpty(props: { bot: boolean; setup: boolean; onOpen: () => void; onNew: () => void }) {
  if (props.setup) return <SetupEmpty onOpen={props.onOpen} onLater={props.onNew} />;
  return <NoSessionEmpty bot={props.bot} onNew={props.onNew} />;
}

function SetupEmpty({ onOpen, onLater }: { onOpen: () => void; onLater: () => void }) {
  const { t } = useI18n();
  return (
    <div className="chat-empty chat-empty--setup">
      <h3 className="chat-empty__title">{t('play.empty.setupTitle')}</h3>
      <p className="chat-empty__hint">{t('play.empty.setupHint')}</p>
      <button type="button" className="btn btn-primary btn-sm chat-empty__cta" onClick={onOpen}>{t('play.empty.setupCta')}</button>
      <button type="button" className="btn btn-ghost btn-sm chat-empty__cta" onClick={onLater}>{t('play.empty.setupLater')}</button>
    </div>
  );
}

function NoSessionEmpty({ bot, onNew }: { bot: boolean; onNew: () => void }) {
  const { t } = useI18n();
  return (
    <div className="chat-empty">
      <h3 className="chat-empty__title">{bot ? t('play.empty.selectOrCreateBot') : t('play.empty.selectOrCreateSession')}</h3>
      <p className="chat-empty__hint">{bot ? t('play.empty.hintBot') : t('play.empty.hintSession')}</p>
      {bot ? <BotCta /> : <button type="button" className="btn btn-primary btn-sm chat-empty__cta" onClick={onNew}>{t('play.newSession')}</button>}
      {bot ? <BotManageLink /> : null}
    </div>
  );
}

function BotCta() {
  const { t } = useI18n();
  return (
    <a className="btn btn-primary btn-sm chat-empty__cta" href={formatHash({ section: 'agents', sub: 'bots' })}>
      {t('play.newBot')}
    </a>
  );
}

function BotManageLink() {
  const { t } = useI18n();
  return (
    <a className="chat-empty__link" href={formatHash({ section: 'agents', sub: 'bots' })}>
      {t('play.settings.manageBots')}
    </a>
  );
}

function NoMessagesEmpty({ setup, onOpen }: { setup: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <div className="chat-empty">
      <h3 className="chat-empty__title">{t('play.empty.noMessages')}</h3>
      <p className="chat-empty__hint">{setup ? t('play.empty.startAfterSetup') : t('play.empty.startChat')}</p>
      {setup ? <button type="button" className="btn btn-primary btn-sm chat-empty__cta" onClick={onOpen}>{t('play.empty.setupCta')}</button> : null}
    </div>
  );
}

function PendingApprovals(props: { approvals: ApprovalItem[]; onDone: () => void; onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void } }) {
  if (!props.approvals.length) return null;
  return <ApprovalBanner approvals={props.approvals} onDone={props.onDone} onAttachStream={props.onAttach} />;
}

interface TranscriptModel {
  empty: boolean;
  selected: boolean;
  slots: FeedSlot[];
  messages: ChatMessage[];
  calls: Calls;
  resolved: Set<string>;
  lines: Array<string | null>;
  anchors: Anchors;
  childTaskGroups: Map<number, ChildTaskStreamEntry[]>;
}

function transcriptView(
  chat: Chat,
  approvals: ApprovalItem[],
  lines: Array<string | null>,
  selected: boolean,
  childTasks: readonly ChildTaskStreamEntry[]
): TranscriptModel {
  const messages = chat.displayMessages;
  const stored = chat.sessionMessages;
  const empty = feedIsEmpty(chat);
  const source = stored.length ? stored : messages;
  const resolved = indexResolvedToolCallIds(source);
  const anchors = anchorApprovals(messages, approvals, resolved, toolSites(chat.streamOverlay?.segments));
  const childTaskGroups = placeChildTaskEntries(messages.map(feedStamp), childTasks);
  return {
    empty,
    selected,
    slots: empty ? [] : withChildTaskSlots(slotsFor(messages, lines, chat, anchors), childTaskGroups),
    messages,
    calls: indexToolCalls(source),
    resolved,
    lines,
    anchors,
    childTaskGroups
  };
}

function feedIsEmpty(chat: Chat): boolean {
  if (chat.transcriptReady === false) return false;
  return !chat.optimisticUser && chat.sessionMessages.length === 0 && !chat.streamOverlay && !chat.waitTyping && !chat.heldAssistantText;
}

function toolSites(segments: ReadonlyArray<{ kind: string; name?: string; toolCallId?: string; args?: string }> | undefined) {
  const sites: Array<{ name: string; toolCallId?: string; args?: string }> = [];
  for (const seg of segments ?? []) {
    if (seg.kind !== 'tool' || !seg.name) continue;
    sites.push({ name: seg.name, toolCallId: seg.toolCallId, args: seg.args });
  }
  return sites;
}

function slotsFor(messages: ChatMessage[], lines: Array<string | null>, chat: Chat, anchors: Anchors): FeedSlot[] {
  const turns = sliceConversationTurns(messages as Array<{ role?: string; createdAt?: unknown }>);
  const segmentCount = chat.streamOverlay?.segments.length ?? 0;
  const steerStream = chat.steerStreamPrefix == null ? undefined : steerStreamPlacement(chat.steerStreamPrefix, segmentCount);
  const stream = steerStream ? steerStream.prefix || steerStream.suffix : Boolean(chat.streamOverlay);
  return buildFeedSlots({
    messages: messages.map((message) => ({ id: messageId(message) })),
    turns: turns.map((slice, turnIndex) => turnSlot(slice.endIndex, turnIndex, lines, turns.length, chat)),
    approvalIndexes: [...anchors.afterMessage.keys()],
    optimistic: Boolean(chat.optimisticUser),
    held: Boolean(chat.heldAssistantText),
    stream,
    streamApproval: anchors.afterStream.length > 0,
    typing: chat.waitTyping,
    trail: anchors.trailing.length > 0,
    steerStream
  });
}

function turnSlot(endIndex: number, turnIndex: number, lines: Array<string | null>, count: number, chat: Chat) {
  const liveTail = Boolean(chat.streamOverlay || chat.waitTyping) && !chat.optimisticUser && turnIndex === count - 1;
  return { endIndex, turnIndex, stats: Boolean(lines[turnIndex]), live: liveTail };
}

function messageId(message: ChatMessage): string | undefined {
  const id = (message as ChatMessage & { id?: unknown }).id;
  if (typeof id !== 'string') return undefined;
  return id;
}

function feedStamp(message: ChatMessage): { id?: string; createdAt?: unknown } {
  const raw = message as ChatMessage & { createdAt?: unknown };
  return { id: messageId(message), createdAt: raw.createdAt };
}

function withChildTaskSlots(slots: FeedSlot[], groups: Map<number, ChildTaskStreamEntry[]>): FeedSlot[] {
  if (groups.size === 0) return slots;
  const next: FeedSlot[] = [];
  for (const slot of slots) {
    next.push(slot);
    if (slot.kind !== 'message' || slot.messageIndex == null || !groups.has(slot.messageIndex)) continue;
    next.push({ key: `child:${slot.messageIndex}`, kind: 'child-task', messageIndex: slot.messageIndex });
  }
  return next;
}

function renderTranscriptSlot(slot: FeedSlot, view: TranscriptModel, props: {
  chat: Chat;
  selectedSessionId: string | null;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
  replyQuoteBot?: { id: string; name: string } | null;
  onQuoteReply?: (quote: ReplyQuote) => void;
  onOpenChildTask?: (sessionId: string) => void;
}, brief = false): ReactNode {
  if (slot.kind === 'brief-note') return <ProcessNote slot={slot} view={view} props={props} />;
  if (slot.kind === 'child-task') {
    const group = view.childTaskGroups.get(slot.messageIndex ?? -1) ?? [];
    return <BotChildTaskStreamEntry entries={group} onOpen={props.onOpenChildTask} />;
  }
  const sessionId = props.selectedSessionId ?? '';
  const live = renderLiveSlot(slot, view, props.chat, sessionId, props.onApprovalsChanged, props.onAttachStream, brief);
  if (live) return live;
  return renderStoredSlot(slot, view, sessionId, props.chat.showModelView, props.onApprovalsChanged, props.onAttachStream, props.replyQuoteBot ?? null, props.onQuoteReply, brief);
}

function renderLiveSlot(slot: FeedSlot, view: TranscriptModel, chat: Chat, sessionId: string, onDone: () => void, onAttach: ((sessionId: string) => { ready: Promise<void>; cancel: () => void }) | undefined, brief: boolean): ReactNode {
  const early = renderOptimisticOrStream(slot, view, chat, sessionId, brief);
  if (early) return early;
  return renderTypingOrTrail(slot, view, onDone, onAttach);
}

function renderOptimisticOrStream(slot: FeedSlot, view: TranscriptModel, chat: Chat, sessionId: string, brief: boolean): ReactNode {
  if (slot.kind === 'held') {
    const text = chat.heldAssistantText;
    if (!text) return null;
    return <ChatTurnPlain role="assistant" text={text} />;
  }
  if (slot.kind === 'optimistic') {
    const reply = chat.optimisticReply;
    return (
      <ChatTurnPlain
        role="user"
        text={chat.optimisticUser ?? ''}
        contextLabels={chat.optimisticContext}
        replyTo={reply}
        replyBotName={reply?.botName}
      />
    );
  }
  if (slot.kind !== 'stream') return null;
  return renderStreamSlot(slot, view, chat, sessionId, brief);
}

function renderStreamSlot(slot: FeedSlot, view: TranscriptModel, chat: Chat, sessionId: string, brief: boolean): ReactNode {
  const raw = rawStreamSegments(slot, chat);
  const segments = omitStreamTextSavedOnTurn(chat.displayMessages, raw);
  if (raw.length > 0 && segments.length === 0) return null;
  return <ChatTurnStreaming retry={slot.streamPart === 'prefix' ? undefined : chat.streamOverlay?.retry} segments={segments} sessionId={sessionId} resolvedCallIds={view.resolved} brief={brief} />;
}

function rawStreamSegments(slot: FeedSlot, chat: Chat) {
  const all = chat.streamOverlay?.segments ?? [];
  const prefix = chat.steerStreamPrefix;
  if (prefix == null || slot.streamPart == null) return all;
  if (slot.streamPart === 'prefix') return all.slice(0, prefix);
  return all.slice(prefix);
}

function renderTypingOrTrail(slot: FeedSlot, view: TranscriptModel, onDone: () => void, onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void }): ReactNode {
  if (slot.kind === 'typing') return <ChatTurnPlain role="assistant" text="…" extraClass="chat-turn--typing" />;
  if (slot.kind !== 'trail') return null;
  return <ApprovalBanner approvals={view.anchors.trailing} onDone={onDone} onAttachStream={onAttach} />;
}

function renderStoredSlot(
  slot: FeedSlot,
  view: TranscriptModel,
  sessionId: string,
  modelView: boolean,
  onDone: () => void,
  onAttach: ((sessionId: string) => { ready: Promise<void>; cancel: () => void }) | undefined,
  quoteBot: { id: string; name: string } | null,
  onQuote?: (quote: ReplyQuote) => void,
  brief = false
): ReactNode {
  if (slot.kind === 'message') return messageSlot(view, sessionId, slotIndex(slot), modelView, quoteBot, onQuote, brief);
  if (slot.kind === 'stats') return statsLine(view.lines, slot.turnIndex);
  if (slot.kind === 'approval') return approvalSlot(slot, view, onDone, onAttach);
  return null;
}

function slotIndex(slot: FeedSlot): number {
  if (slot.messageIndex == null) return 0;
  return slot.messageIndex;
}

function messageSlot(
  view: TranscriptModel,
  sessionId: string,
  index: number,
  modelView: boolean,
  quoteBot: { id: string; name: string } | null,
  onQuote?: (quote: ReplyQuote) => void,
  brief = false
): ReactNode {
  const message = view.messages[index];
  if (!message) return null;
  const replyNames = quoteBot ? { [quoteBot.id]: quoteBot.name } : undefined;
  if (messageHasStructuredParts(message.parts)) {
    return <ChatTurnIfVisible m={message} sessionId={sessionId} msgIndex={index} modelView={modelView} toolCallsById={view.calls} resolvedCallIds={view.resolved} quoteBot={quoteBot} onQuote={onQuote} replyNames={replyNames} brief={brief} />;
  }
  const role = normalizedRole(message);
  if (role === 'tool' || role === 'system') {
    return (
      <ChatTurnPlain
        role={role}
        text={msgPartsToText(message.parts)}
        messageSessionId={readMessageSessionId(message as { sessionId?: unknown })}
        conversationId={sessionId}
      />
    );
  }
  return <ChatTurnIfVisible m={message} sessionId={sessionId} msgIndex={index} modelView={modelView} toolCallsById={view.calls} resolvedCallIds={view.resolved} quoteBot={quoteBot} onQuote={onQuote} replyNames={replyNames} brief={brief} />;
}

function approvalSlot(slot: FeedSlot, view: TranscriptModel, onDone: () => void, onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void }): ReactNode {
  const pending = slot.messageIndex == null ? view.anchors.afterStream : view.anchors.afterMessage.get(slot.messageIndex);
  if (!pending?.length) return null;
  return <ApprovalBanner approvals={pending} onDone={onDone} onAttachStream={onAttach} />;
}

function statsLine(lines: Array<string | null>, turnIndex: number | undefined): ReactNode {
  if (turnIndex == null) return null;
  const line = lines[turnIndex];
  if (!line) return null;
  return <TurnStats line={line} turnIndex={turnIndex} />;
}

function TurnStats({ line, turnIndex }: { line: string; turnIndex: number }) {
  const { t } = useI18n();
  return (
    <footer className="chat-feed-stats chat-feed-stats--turn" aria-label={t('play.chrome.feedStatsAria')} data-turn-index={String(turnIndex)}>
      {line}
    </footer>
  );
}


'use client';

import type { ReactNode } from 'react';
import type { ApprovalItem, ChatMessage } from '@/lib/types';
import { anchorApprovals } from '@/lib/approval-feed';
import { messageHasStructuredParts, msgPartsToText, normalizedRole } from '@/lib/chat-utils';
import { buildFeedSlots, type FeedSlot } from '@/lib/feed-window';
import { formatHash } from '@/lib/nav';
import { useI18n } from '@/lib/i18n';
import { indexResolvedToolCallIds, indexToolCalls } from '@/lib/tool-io';
import { sliceConversationTurns } from '@/lib/turn-feed-stats';
import { ApprovalBanner } from './ApprovalBanner';
import { ChatFeedWindow } from './ChatFeedWindow';
import { ChatTurnFromMessage, ChatTurnPlain, ChatTurnStreaming } from './ChatTurns';
import { SurfaceContextProvider } from './a2ui/SurfaceContext';
import type { usePlayChat } from './usePlayChat';

type Chat = ReturnType<typeof usePlayChat>;
type Calls = ReturnType<typeof indexToolCalls>;
type Anchors = ReturnType<typeof anchorApprovals<ApprovalItem>>;

export function PlayTranscript(props: {
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
}) {
  const view = transcriptView(props.chat, props.sessionApprovals, props.turnFeedStatLines, Boolean(props.selectedSessionId));
  return (
    <SurfaceContextProvider messages={props.chat.displayMessages}>
      <ChatFeedWindow
        scrollerRef={props.chat.playMessagesRef}
        slots={view.slots}
        renderSlot={(slot) => renderTranscriptSlot(slot, view, props)}
        stickToBottomRef={props.chat.playStickToBottomRef}
        scrollIntentRef={props.chat.feedScrollIntentRef}
        revision={props.chat.feedRevision}
        hasOlder={props.chat.historyCursor != null}
        olderLoading={props.chat.historyLoading}
        onStickScroll={props.chat.handlePlayMessagesScroll}
        onRequestOlder={(reason) => void props.chat.loadOlderHistory(reason)}
        header={<FeedHeader view={view} {...props} />}
        footer={props.footer}
      />
    </SurfaceContextProvider>
  );
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
      <OlderButton chat={props.chat} />
      <TranscriptEmpty {...props} />
    </>
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

function OlderButton({ chat }: { chat: Chat }) {
  const { t } = useI18n();
  if (chat.historyCursor == null) return null;
  return (
    <div className="chat-feed__older">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        data-testid="feed-load-older"
        disabled={chat.historyLoading}
        onClick={() => void chat.loadOlderHistory('scroll')}
      >
        {t('botWork.older')}
      </button>
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
}

function transcriptView(chat: Chat, approvals: ApprovalItem[], lines: Array<string | null>, selected: boolean): TranscriptModel {
  const messages = chat.displayMessages;
  const stored = chat.sessionMessages;
  const empty = feedIsEmpty(chat);
  const source = stored.length ? stored : messages;
  const resolved = indexResolvedToolCallIds(source);
  const anchors = anchorApprovals(messages, approvals, resolved, toolSites(chat.streamOverlay?.segments));
  return {
    empty,
    selected,
    slots: empty ? [] : slotsFor(messages, lines, chat, anchors),
    messages,
    calls: indexToolCalls(source),
    resolved,
    lines,
    anchors
  };
}

function feedIsEmpty(chat: Chat): boolean {
  if (chat.transcriptReady === false) return false;
  return !chat.optimisticUser && chat.sessionMessages.length === 0 && !chat.streamOverlay && !chat.waitTyping;
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
  return buildFeedSlots({
    messages: messages.map((message) => ({ id: messageId(message) })),
    turns: turns.map((slice, turnIndex) => turnSlot(slice.endIndex, turnIndex, lines, turns.length, chat)),
    approvalIndexes: [...anchors.afterMessage.keys()],
    optimistic: Boolean(chat.optimisticUser),
    stream: Boolean(chat.streamOverlay),
    streamApproval: anchors.afterStream.length > 0,
    typing: chat.waitTyping,
    trail: anchors.trailing.length > 0
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

function renderTranscriptSlot(slot: FeedSlot, view: TranscriptModel, props: {
  chat: Chat;
  selectedSessionId: string | null;
  onApprovalsChanged: () => void;
  onAttachStream?: (sessionId: string) => { ready: Promise<void>; cancel: () => void };
}): ReactNode {
  const sessionId = props.selectedSessionId ?? '';
  const live = renderLiveSlot(slot, view, props.chat, sessionId, props.onApprovalsChanged, props.onAttachStream);
  if (live) return live;
  return renderStoredSlot(slot, view, sessionId, props.chat.showModelView, props.onApprovalsChanged, props.onAttachStream);
}

function renderLiveSlot(slot: FeedSlot, view: TranscriptModel, chat: Chat, sessionId: string, onDone: () => void, onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void }): ReactNode {
  const early = renderOptimisticOrStream(slot, view, chat, sessionId);
  if (early) return early;
  return renderTypingOrTrail(slot, view, onDone, onAttach);
}

function renderOptimisticOrStream(slot: FeedSlot, view: TranscriptModel, chat: Chat, sessionId: string): ReactNode {
  if (slot.kind === 'optimistic') {
    return <ChatTurnPlain role="user" text={chat.optimisticUser ?? ''} contextLabels={chat.optimisticContext} />;
  }
  if (slot.kind !== 'stream') return null;
  return <ChatTurnStreaming segments={chat.streamOverlay?.segments ?? []} sessionId={sessionId} resolvedCallIds={view.resolved} />;
}

function renderTypingOrTrail(slot: FeedSlot, view: TranscriptModel, onDone: () => void, onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void }): ReactNode {
  if (slot.kind === 'typing') return <ChatTurnPlain role="assistant" text="…" extraClass="chat-turn--typing" />;
  if (slot.kind !== 'trail') return null;
  return <ApprovalBanner approvals={view.anchors.trailing} onDone={onDone} onAttachStream={onAttach} />;
}

function renderStoredSlot(slot: FeedSlot, view: TranscriptModel, sessionId: string, modelView: boolean, onDone: () => void, onAttach?: (sessionId: string) => { ready: Promise<void>; cancel: () => void }): ReactNode {
  if (slot.kind === 'message') return messageSlot(view, sessionId, slotIndex(slot), modelView);
  if (slot.kind === 'stats') return statsLine(view.lines, slot.turnIndex);
  if (slot.kind === 'approval') return approvalSlot(slot, view, onDone, onAttach);
  return null;
}

function slotIndex(slot: FeedSlot): number {
  if (slot.messageIndex == null) return 0;
  return slot.messageIndex;
}

function messageSlot(view: TranscriptModel, sessionId: string, index: number, modelView: boolean): ReactNode {
  const message = view.messages[index];
  if (!message) return null;
  if (messageHasStructuredParts(message.parts)) {
    return <ChatTurnFromMessage m={message} sessionId={sessionId} msgIndex={index} modelView={modelView} toolCallsById={view.calls} resolvedCallIds={view.resolved} />;
  }
  const role = normalizedRole(message);
  if (role === 'tool' || role === 'system') return <ChatTurnPlain role={role} text={msgPartsToText(message.parts)} />;
  return <ChatTurnFromMessage m={message} sessionId={sessionId} msgIndex={index} modelView={modelView} toolCallsById={view.calls} resolvedCallIds={view.resolved} />;
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


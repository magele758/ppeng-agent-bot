'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { liveReplyHoldIndex } from '@/lib/reply-end-actions';
import { captureLine, restoreLine, type ReadingLine } from './rail-reading-line';
import { messageRange } from './source-dom';
import type { ChatMessage } from '@/lib/types';
import type { SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import { readFeedAnchor } from '../../lib/feed-window';
import { replyMessageId, replySourceText } from '../../lib/reply-quote';
import {
  SidechatPanel,
  useSidechatDraftBook,
  useSidechatThreads,
  type SidechatPanelRequest
} from './SidechatPanel';
import { SourceBindings } from './SourceBindings';
import { SourceContext } from './SourceContext';
import { restoreTop, revealReadingSpot, type Chat, type Destination, type ReadingSpot } from './reading-position';
import './source.css';

const DockContext = createContext<ReactNode>(null);
type Screen = { sessionId: string; request: SidechatPanelRequest };
type Bookmark = Screen & { spot: ReadingSpot };
type Props = {
  sessionId: string | null;
  enabled: boolean;
  chat: Chat;
  onNavigate: (id: string) => Promise<void>;
  children: ReactNode;
};

function useSourceJump(chat: Chat, target: Destination | null, onResult: (status: string) => void) {
  const live = useRef(chat);
  live.current = chat;
  const report = useRef(onResult);
  report.current = onResult;
  useEffect(() => {
    if (!target || chat.loadedTranscriptSessionId !== target.sessionId) return;
    const controller = new AbortController();
    void revealReadingSpot(live, target, controller.signal).then((result) => {
      if (result && !controller.signal.aborted) report.current(result);
    });
    return () => controller.abort();
  }, [target, chat.loadedTranscriptSessionId]);
}
export function SidechatWorkspace(props: Props) {
  if (!props.enabled || !props.sessionId) return <>{props.children}</>;
  return <SessionWorkspace {...props} sessionId={props.sessionId} />;
}
function SessionWorkspace({ sessionId, chat, onNavigate, children }: Props & { sessionId: string }) {
  const { t } = useI18n();
  const list = useSidechatThreads(sessionId);
  const drafts = useSidechatDraftBook();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [backstack, setBackstack] = useState<Bookmark[]>([]);
  const [target, setTarget] = useState<Destination | null>(null);
  const [notice, setNotice] = useState('');
  const model = useRef<SidechatPanelRequest>({ kind: 'list' });
  const origin = useRef<HTMLElement | null>(null);
  const entryMessage = useRef('');
  const layout = useRef<{ spot: ReadingSpot; line: ReadingLine | null } | null>(null);
  const openedAt = useRef<number | null>(null);
  const route = useRef(0);
  const visible = screen?.sessionId === sessionId;
  const expectedSession = useRef(sessionId);
  useEffect(() => {
    if (expectedSession.current === sessionId) return;
    expectedSession.current = sessionId;
    route.current++;
    setScreen(null);
    setBackstack([]);
    setTarget(null);
    setNotice('');
  }, [sessionId]);
  const feed = chat.playMessagesRef;
  function keepPlace(view?: SidechatPanelRequest) {
    const el = feed.current;
    if (!el) return;
    const wanted = preferredLine(el, view, list.threads);
    layout.current = { spot: readFeedAnchor(el), line: captureLine(el, wanted) };
    chat.playStickToBottomRef.current = false;
    chat.feedScrollIntentRef.current = null;
  }
  useLayoutEffect(() => {
    const saved = layout.current;
    layout.current = null;
    if (!saved || !feed.current) return;
    if (!restoreLine(feed.current, saved.line)) restoreTop(feed.current, saved.spot);
    openedAt.current = visible ? feed.current.scrollTop : null;
  }, [visible, feed]);
  function open(request: SidechatPanelRequest) {
    if (!sessionId) return;
    if (!visible) {
      origin.current = document.activeElement as HTMLElement;
      keepPlace(request);
    }
    if (request.kind === 'draft') entryMessage.current = request.messageId;
    setNotice('');
    model.current = request;
    setScreen({ sessionId, request });
  }
  function close() {
    keepPlace(openedAt.current === feed.current?.scrollTop ? model.current : undefined);
    setScreen(null);
    setNotice('');
    requestAnimationFrame(() => restoreFocus(origin.current, feed.current, entryMessage.current));
  }
  const onViewChange = useCallback((request: SidechatPanelRequest) => {
    model.current = request;
    setScreen((prev) => prev && { ...prev, request });
  }, []);
  function finishJump(result: string) {
    if (result !== 'done')
      setNotice(t(result === 'changed' ? 'sidechatSource.changed' : 'sidechatSource.missing'));
    setTarget(null);
  }
  useSourceJump(chat, target, finishJump);
  async function visit(next: Screen, destination: Destination) {
    const ticket = ++route.current;
    expectedSession.current = next.sessionId;
    setTarget(null);
    setNotice('');
    if (next.sessionId !== sessionId) await onNavigate(next.sessionId);
    if (ticket !== route.current) return;
    model.current = next.request;
    setScreen(drawerCoversFeed() ? null : next);
    setTarget(destination);
  }
  function locate(thread: SidechatThread) {
    if (drawerCoversFeed()) setScreen(null);
    setNotice('');
    setTarget({ sessionId: thread.sessionId, thread });
  }
  function openSource(thread: SidechatThread) {
    if (!sessionId) return;
    const bookmark = { sessionId, request: model.current, spot: readFeedAnchor(feed.current) };
    setBackstack((prev) => [...prev, bookmark]);
    void visit(
      { sessionId: thread.sessionId, request: { kind: 'thread', threadId: thread.id } },
      { sessionId: thread.sessionId, thread }
    );
  }
  function goBack() {
    const parent = backstack.at(-1);
    if (!parent) return;
    setBackstack((prev) => prev.slice(0, -1));
    void visit(parent, { sessionId: parent.sessionId, spot: parent.spot });
  }
  function newDraft() {
    const id = sourceOfView(model.current, list.threads);
    const held = liveReplyHoldIndex(chat.sessionMessages, chat);
    const source = pickReply(chat.sessionMessages.slice(0, held ?? undefined), id, feed.current);
    if (!source) {
      setNotice(t('sidechatSource.missing'));
      return;
    }
    open({
      kind: 'draft',
      messageId: replyMessageId(source),
      anchor: { kind: 'message', quote: replySourceText(source.parts).trim().slice(0, 320) }
    });
  }
  const actions = {
    threads: list.threads,
    activeId: activeId(visible, model.current),
    open,
    back: backstack.length ? goBack : undefined
  };
  const panel = visible ? (
    <aside data-testid="sidechat-dock" className="sidechat-dock">
      {notice && <p role="status">{notice}</p>}
      <SidechatPanel
        key={screen.sessionId}
        sessionId={screen.sessionId}
        request={screen.request}
        threads={list.threads}
        error={list.error}
        draftBook={drafts}
        onRefresh={list.refresh}
        onClose={close}
        onNew={newDraft}
        onLocate={locate}
        onOpenSource={openSource}
        onReturn={actions.back}
        onViewChange={onViewChange}
      />
    </aside>
  ) : null;
  return (
    <SourceContext.Provider value={actions}>
      <DockContext.Provider value={panel}>{children}</DockContext.Provider>
      {
        <SourceBindings
          feedRef={feed}
          threads={list.threads}
          open={open}
          sessionId={sessionId}
          current={visible ? screen.request : null}
        />
      }
      <LocationNotice notice={notice} visible={visible} />
    </SourceContext.Provider>
  );
}
export function SidechatDock() {
  return useContext(DockContext);
}

function drawerCoversFeed() {
  return window.matchMedia('(max-width:1100px)').matches;
}
function LocationNotice({ notice, visible }: { notice: string; visible: boolean }) {
  return notice && !visible ? (
    <p className="sidechat-location-notice" role="status">
      {notice}
    </p>
  ) : null;
}

function sourceOfView(view: SidechatPanelRequest, threads: SidechatThread[]) {
  if (view.kind === 'draft') return view.messageId;
  if (view.kind === 'thread') return threads.find((thread) => thread.id === view.threadId)?.messageId;
}
function visibleSource(feed: HTMLElement | null) {
  if (!feed) return;
  const box = feed.getBoundingClientRect();
  const visible = [...feed.querySelectorAll<HTMLElement>('[data-sidechat-message]')].filter((row) => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
  return visible.at(-1)?.dataset.sidechatMessage;
}
function pickReply(messages: ChatMessage[], id: string | undefined, feed: HTMLElement | null) {
  const preferred = id ?? visibleSource(feed);
  const found = messages.find((m) => m.role === 'assistant' && replyMessageId(m) === preferred);
  return found ?? [...messages].reverse().find((m) => m.role === 'assistant' && replySourceText(m.parts).trim());
}
function restoreFocus(origin: HTMLElement | null, feed: HTMLElement | null, messageId: string) {
  if (origin?.isConnected && origin !== document.body) {
    origin.focus({ preventScroll: true });
    return;
  }
  const row = feed?.querySelector<HTMLElement>(
    `[data-sidechat-message="${CSS.escape(messageId)}"] [data-testid="sidechat-whole"]`
  );
  const target = row ?? document.querySelector<HTMLElement>('[data-testid="sidechat-entry"]');
  target?.focus({ preventScroll: true });
}

function preferredLine(feed: HTMLElement, view: SidechatPanelRequest | undefined, threads: SidechatThread[]) {
  if (!view || view.kind === 'list') return null;
  const source = view.kind === 'draft' ? view : threads.find((t) => t.id === view.threadId);
  if (!source) return null;
  return messageRange(feed, source);
}

function activeId(visible: boolean, request: SidechatPanelRequest) {
  return visible && request.kind === 'thread' ? request.threadId : null;
}

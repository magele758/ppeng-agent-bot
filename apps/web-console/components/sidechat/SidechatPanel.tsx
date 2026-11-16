'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import {
  draftAddress,
  sidechatRequestId,
  type SidechatDraftBook,
  type SidechatEditorTarget,
  type SidechatPanelRequest
} from '@/lib/sidechat-editor';
import { changeGeneration, submitSidechat, type SidechatDetail } from '@/lib/sidechat-api';
import { SidechatSearch } from './SidechatSearch';
import { LoadError, Loading, SidechatMessages, SourceLink } from './SidechatMessages';
import { useSidechatDetail, useSidechatDraftBook } from './useSidechats';
import './sidechat.css';

export type { SidechatPanelRequest } from '@/lib/sidechat-editor';
export { useSidechatDraftBook, useSidechatThreads } from './useSidechats';

type Props = {
  sessionId: string;
  request: SidechatPanelRequest | null;
  threads: SidechatThread[];
  error?: string;
  draftBook?: SidechatDraftBook;
  onRefresh: () => void;
  onClose: () => void;
  onNew: () => void;
  onLocate: (thread: SidechatThread) => void;
  onOpenSource: (thread: SidechatThread) => void;
  onReturn?: () => void;
  onViewChange?: (request: SidechatPanelRequest) => void;
};
const list: SidechatPanelRequest = { kind: 'list' };
type SearchScope = { quote?: string };
function MenuButton({ onClick, label, testId }: { onClick: () => void; label: string; testId?: string }) {
  return (
    <button type="button" className="sc-button" data-testid={testId} onClick={onClick}>
      {label}
    </button>
  );
}
function requestedView(view: SidechatPanelRequest | null) {
  return view ?? list;
}
function threadId(view: SidechatPanelRequest) {
  return view.kind === 'thread' ? view.threadId : null;
}
export function SidechatPanel(props: Props) {
  const { t } = useI18n();
  const fallback = useSidechatDraftBook();
  const [view, setView] = useState<SidechatPanelRequest>(requestedView(props.request));
  const [search, setSearch] = useState<SearchScope | null>(null);
  const active = useRef<SidechatPanelRequest | null>(view);
  active.current = search ? null : view;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const next = props.request ?? list;
    setView(next);
    setSearch(null);
  }, [props.request, props.sessionId]);
  function select(next: SidechatPanelRequest) {
    active.current = next;
    setView(next);
    setSearch(null);
    props.onViewChange?.(next);
  }
  function sent(origin: SidechatEditorTarget, detail: SidechatDetail) {
    props.onRefresh();
    if (!mounted.current || active.current !== origin) return;
    select({ kind: 'thread', threadId: detail.thread.id });
  }
  const book = props.draftBook ?? fallback;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!panel.current?.contains(event.target as Node)) return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [props.onClose]);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="sc-panel"
      data-testid="sidechat-panel"
      data-list={view.kind === 'list'}
      aria-label={t('sidechat.name')}
    >
      <header className="sc-heading">
        <h2>{t('sidechat.name')}</h2>
        <div>
          {props.onReturn && <MenuButton label={t('sidechat.returnReading')} onClick={props.onReturn} />}
          <MenuButton label={t('sidechat.close')} onClick={props.onClose} testId="sidechat-close" />
        </div>
      </header>
      {search ? (
        <SidechatSearch
          sessionId={props.sessionId}
          quote={search.quote}
          onBack={() => setSearch(null)}
          onOpen={props.onOpenSource}
        />
      ) : (
        <>
          <ThreadList
            threads={props.threads}
            view={view}
            onSelect={select}
            onAll={() => setSearch({})}
            onNew={props.onNew}
            error={props.error}
            retry={props.onRefresh}
          />
          <Conversation
            key={props.sessionId}
            view={view}
            sessionId={props.sessionId}
            book={book}
            onLocate={props.onLocate}
            onRelated={(quote) => setSearch({ quote })}
            onSent={sent}
            onRefresh={props.onRefresh}
          />
        </>
      )}
    </section>
  );
}

type ListProps = {
  threads: SidechatThread[];
  view: SidechatPanelRequest;
  onSelect: (v: SidechatPanelRequest) => void;
  onAll: () => void;
  onNew: () => void;
  error?: string;
  retry: () => void;
};
function listedThreads(threads: SidechatThread[], view: SidechatPanelRequest) {
  if (view.kind !== 'list' || !view.threadIds) return threads;
  const ids = new Set(view.threadIds);
  return threads.filter((t) => ids.has(t.id));
}
function ThreadList(p: ListProps) {
  const { t, locale } = useI18n();
  const items = listedThreads(p.threads, p.view);
  return (
    <div className="sc-library">
      <div className="sc-library-bar">
        <div className="sc-tabs">
          <MenuButton
            label={t('sidechat.sessionCount', { count: p.threads.length })}
            onClick={() => p.onSelect(list)}
          />
          <MenuButton label={t('sidechat.all')} onClick={p.onAll} testId="sidechat-all" />
        </div>
        <MenuButton label={t('sidechat.add')} onClick={p.onNew} testId="sidechat-new" />
      </div>
      <div className="sc-thread-list">
        {items.map((thread) => (
          <button
            type="button"
            key={thread.id}
            data-testid="sidechat-thread"
            aria-pressed={thread.id === threadId(p.view)}
            onClick={() => p.onSelect({ kind: 'thread', threadId: thread.id })}
          >
            <span className="sc-index">{thread.ordinal}</span>
            <span className="sc-thread-copy">
              <strong>{thread.title}</strong>
              <small>{thread.anchor.quote}</small>
            </span>
            <time dateTime={thread.updatedAt}>{new Date(thread.updatedAt).toLocaleDateString(locale)}</time>
          </button>
        ))}
      </div>
      {p.error ? (
        <LoadError retry={p.retry} />
      ) : (
        items.length === 0 && <p className="sc-note">{t('sidechat.empty')}</p>
      )}
    </div>
  );
}
type ConvoProps = {
  view: SidechatPanelRequest;
  sessionId: string;
  book: SidechatDraftBook;
  onLocate: (t: SidechatThread) => void;
  onRelated: (q: string) => void;
  onSent: (from: SidechatEditorTarget, detail: SidechatDetail) => void;
  onRefresh: () => void;
};
function Conversation(p: ConvoProps) {
  const { t } = useI18n();
  const resource = useSidechatDetail(threadId(p.view), p.onRefresh);
  if (p.view.kind === 'list') return <p className="sc-note sc-select">{t('sidechat.select')}</p>;
  if (p.view.kind === 'thread' && !resource.detail)
    return <DetailPlaceholder fault={resource.fault} retry={resource.refresh} />;
  return (
    <Editor
      key={draftAddress(p.sessionId, p.view)}
      {...p}
      target={p.view}
      detail={resource.detail}
      receive={resource.received}
    />
  );
}
function DetailPlaceholder({ fault, retry }: { fault: string; retry: () => void }) {
  return fault ? <LoadError retry={retry} /> : <Loading />;
}
function cannotSend(book: SidechatDraftBook, key: string, generating: boolean) {
  return generating || book.sending(key) || !book.text(key).trim();
}
type EditorProps = ConvoProps & {
  target: SidechatEditorTarget;
  detail?: SidechatDetail;
  receive: (detail: SidechatDetail) => void;
};
function Editor(p: EditorProps) {
  const { t } = useI18n();
  const key = draftAddress(p.sessionId, p.target);
  useSyncExternalStore(p.book.subscribe, p.book.snapshot, p.book.snapshot);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  const generating = p.detail?.thread.status === 'generating';
  async function send() {
    if (generating) return;
    const req = p.book.begin(key);
    if (!req) return;
    setFailed(false);
    try {
      const detail = await submitSidechat(p.sessionId, p.target, req);
      p.book.sent(key, req, draftAddress(p.sessionId, { kind: 'thread', threadId: detail.thread.id }));
      p.receive(detail);
      p.onSent(p.target, detail);
    } catch {
      p.book.failed(key, req);
      setFailed(true);
    }
  }
  const change = (text: string) => p.book.edit(key, text);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [p.detail?.messages]);
  return (
    <>
      <div className="sc-pinned-source">
        <SourceCard target={p.target} detail={p.detail} onLocate={p.onLocate} onRelated={p.onRelated} />
      </div>
      <div
        ref={scroll}
        data-sidechat-scroll
        className="sc-thread-detail"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 50;
        }}
      >
        {p.detail ? (
          <SidechatMessages
            messages={p.detail.messages}
            author={p.detail.thread.botId || p.detail.thread.agentId}
          />
        ) : (
          <MenuButton
            label={t('sidechat.explain')}
            onClick={() => {
              change(t('sidechat.explainPrompt'));
              input.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
      <div className="sc-compose">
        {p.detail && (
          <Generation
            detail={p.detail}
            receive={(next) => {
              p.receive(next);
              p.onRefresh();
            }}
          />
        )}
        {failed && (
          <p role="alert" className="sc-error">
            {t('sidechat.sendError')}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            data-testid="sidechat-input"
            aria-label={t('sidechat.input')}
            placeholder={t('sidechat.input')}
            rows={2}
            value={p.book.text(key)}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="sc-compose-actions">
            <small>{t('sidechat.only')}</small>
            <button type="submit" data-testid="sidechat-send" disabled={cannotSend(p.book, key, generating)}>
              {t('sidechat.send')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
function SourceCard(p: Pick<EditorProps, 'target' | 'detail' | 'onLocate' | 'onRelated'>) {
  const { t } = useI18n();
  const thread = p.detail?.thread;
  const a = p.target.kind === 'draft' ? p.target.anchor : thread?.anchor;
  if (!a) return null;
  return (
    <div className="sc-source">
      <div className="sc-heading">
        <small>
          {t('sidechat.source')} {thread?.ordinal}
        </small>
        {p.detail && <SourceLink detail={p.detail} onOpen={p.onLocate} />}
      </div>
      <blockquote>{a.quote}</blockquote>
      {a.kind === 'range' && (
        <MenuButton
          label={t('sidechat.findSame')}
          onClick={() => p.onRelated(a.quote)}
          testId="sidechat-related"
        />
      )}
    </div>
  );
}
function actionToken(status: string, assistant: SidechatDetail['messages'][number], attempt: { current: string }) {
  if (status === 'generating') return assistant.generationId;
  if (!attempt.current) attempt.current = sidechatRequestId();
  return attempt.current;
}
function Generation({ detail, receive }: { detail: SidechatDetail; receive: (detail: SidechatDetail) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attempt = useRef('');
  const status = detail.thread.status;
  const act = useCallback(async () => {
    const assistant = detail.messages.findLast((m) => m.role === 'assistant');
    if (!assistant) return;
    const token = actionToken(status, assistant, attempt);
    if (!token) return;
    const action = status === 'generating' ? 'stop' : 'retry';
    setFailed(false);
    setBusy(true);
    try {
      receive(await changeGeneration(detail.thread.id, action, assistant.requestId, token));
      attempt.current = '';
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [detail, receive, status]);
  if (status === 'complete') return null;
  return (
    <div className="sc-generation">
      <span role="status">{t(`sidechat.${status}` as const)}</span>
      <button type="button" disabled={busy} onClick={() => void act()}>
        {t(status === 'generating' ? 'sidechat.stop' : 'sidechat.retry')}
      </button>
      {failed && <span role="alert">{t('sidechat.actionError')}</span>}
    </div>
  );
}

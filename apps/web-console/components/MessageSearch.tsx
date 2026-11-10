'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  formatMessageSearchTime,
  hitKey,
  hitTitle,
  idleMessageSearch,
  messageSearchStatusText,
  subscribeMessageSearch,
  type MessageSearchHit,
  type MessageSearchPhase,
  type MessageSearchView
} from '@/lib/message-search';

export function MessageSearch({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [query, setQuery] = useState('');
  const view = useMessageSearchQuery(query);
  return <MessageSearchPanel query={query} view={view} onQuery={setQuery} onOpen={onOpenSession} />;
}

export function MessageSearchPanel({
  query,
  view,
  onQuery,
  onOpen
}: {
  query: string;
  view: MessageSearchView;
  onQuery: (next: string) => void;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const status = messageSearchStatusText(view, t);
  return (
    <section className="message-search" data-testid="message-search" aria-label={t('play.messageSearch.aria')}>
      <MessageSearchField
        query={query}
        onQuery={onQuery}
        label={t('play.messageSearch.label')}
        placeholder={t('play.messageSearch.placeholder')}
      />
      {status ? <MessageSearchStatus phase={view.phase} text={status} /> : null}
      {view.phase === 'ready' ? <MessageSearchHitList hits={view.hits} onOpen={onOpen} /> : null}
    </section>
  );
}

function useMessageSearchQuery(query: string): MessageSearchView {
  const [view, setView] = useState<MessageSearchView>(idleMessageSearch());
  useEffect(() => subscribeMessageSearch(query, setView), [query]);
  return view;
}

function MessageSearchField({
  query,
  onQuery,
  label,
  placeholder
}: {
  query: string;
  onQuery: (next: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <label className="message-search__field">
      <span className="message-search__label">{label}</span>
      <input
        type="search"
        className="input-compact"
        data-testid="message-search-input"
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
    </label>
  );
}

function MessageSearchStatus({ phase, text }: { phase: MessageSearchPhase; text: string }) {
  return (
    <p className={statusClass(phase)} role={statusRole(phase)} data-testid="message-search-status">
      {text}
    </p>
  );
}

function MessageSearchHitList({
  hits,
  onOpen
}: {
  hits: MessageSearchHit[];
  onOpen: (sessionId: string) => void;
}) {
  return (
    <ul className="message-search__hits" data-testid="message-search-hits">
      {hits.map((hit) => (
        <li key={hitKey(hit)}>
          <MessageSearchHitButton hit={hit} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function MessageSearchHitButton({
  hit,
  onOpen
}: {
  hit: MessageSearchHit;
  onOpen: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const title = hitTitle(hit, t('play.messageSearch.untitled'));
  return (
    <button
      type="button"
      className="list-item list-item--session message-search__hit"
      data-testid="message-search-hit"
      data-session-id={hit.sessionId}
      aria-label={t('play.messageSearch.open', { title })}
      onClick={() => onOpen(hit.sessionId)}
    >
      <span className="session-item__title">{title}</span>
      <span className="message-search__snippet">{hit.snippet}</span>
      <time className="message-search__time" dateTime={hit.createdAt}>
        {formatMessageSearchTime(hit.createdAt)}
      </time>
    </button>
  );
}

function statusClass(phase: MessageSearchPhase): string {
  if (phase === 'error') return 'message-search__status is-error';
  return 'message-search__status';
}

function statusRole(phase: MessageSearchPhase): 'alert' | 'status' {
  if (phase === 'error') return 'alert';
  return 'status';
}

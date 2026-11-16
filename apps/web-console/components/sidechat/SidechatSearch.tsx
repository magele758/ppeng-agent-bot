'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SidechatSearchHit, SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import { searchSidechats, type SidechatPage, type SidechatQuery } from '@/lib/sidechat-api';
import { Loading, LoadError, SidechatMessages, SourceLink } from './SidechatMessages';
import { useSidechatDetail } from './useSidechats';

type Filter = { scope?: string; bot?: string; from?: string; to?: string };
type SearchProps = {
  sessionId: string;
  quote?: string;
  onBack: () => void;
  onOpen: (thread: SidechatThread) => void;
};
type Pick = { hit: SidechatSearchHit; messageId?: string };
const blankPage: SidechatPage = { items: [] };
function initialQuery(sessionId: string, quote?: string): SidechatQuery {
  return quote === undefined ? {} : { exactQuote: quote, excludeSessionId: sessionId };
}
function dateBoundary(day: string | undefined, end: boolean) {
  if (!day) return undefined;
  const date = new Date(day + 'T00:00:00');
  if (end) date.setHours(23, 59, 59, 999);
  return date.toISOString();
}
function options(hits: SidechatSearchHit[]) {
  return {
    sessions: new Map(hits.map((hit) => [hit.thread.sessionId, hit.sessionTitle || hit.thread.sessionId])),
    bots: [...new Set(hits.flatMap((hit) => (hit.thread.botId ? [hit.thread.botId] : [])))]
  };
}

function useSearchPage(query: SidechatQuery) {
  const key = JSON.stringify(query);
  const [cursor, setCursor] = useState(0);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState({ key: '', page: blankPage });
  const [phase, setPhase] = useState<'busy' | 'ok' | 'error'>('busy');

  const [currentKey, setCurrentKey] = useState(key);
  if (currentKey !== key) {
    setCurrentKey(key);
    setCursor(0);
  }
  const retry = useCallback(() => {
    setResult({ key: '', page: blankPage });
    setPhase('busy');
    setCursor(0);
    setVersion((n) => n + 1);
  }, []);
  useEffect(() => {
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [retry]);
  useEffect(() => {
    const controller = new AbortController();
    setPhase('busy');
    const load = async () => {
      try {
        const page = await searchSidechats(JSON.parse(key), cursor, controller.signal);
        if (controller.signal.aborted) return;
        setResult((prev) => ({ key, page: appendPage(prev, page, key, cursor) }));
        setPhase('ok');
      } catch {
        if (!controller.signal.aborted) {
          setResult({ key: '', page: blankPage });
          setPhase('error');
        }
      }
    };
    const timer = window.setTimeout(load, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, cursor, version]);
  const page = result.key === key ? result.page : blankPage;
  return {
    page,
    phase,
    more: () => setCursor(page.nextCursor ?? 0),
    retry
  };
}
function uniqueHits(a: SidechatSearchHit[], b: SidechatSearchHit[]) {
  return [...new Map([...a, ...b].map((hit) => [hit.thread.id, hit])).values()];
}
function appendPage(prev: { key: string; page: SidechatPage }, next: SidechatPage, key: string, cursor: number) {
  if (!cursor || prev.key !== key) return next;
  return { ...next, items: uniqueHits(prev.page.items, next.items) };
}

export function SidechatSearch(props: SearchProps) {
  const { t } = useI18n();
  const [pick, setPick] = useState<Pick | null>(null);
  const [wide, setWide] = useState(false);
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState<Filter>({});
  const related = props.quote !== undefined && !wide;
  const query = related
    ? initialQuery(props.sessionId, props.quote)
    : {
        q: input.trim(),
        sessionId: filter.scope,
        botId: filter.bot,
        from: dateBoundary(filter.from, false),
        to: dateBoundary(filter.to, true)
      };
  const search = useSearchPage(query);
  function backToResults() {
    search.retry();
    setPick(null);
  }
  if (pick) return <SearchPreview pick={pick} back={backToResults} open={props.onOpen} />;
  function widen() {
    setInput(props.quote ?? '');
    setWide(true);
  }
  const heading = searchHeading(related);
  return (
    <div className="sc-search" data-testid="sidechat-search">
      <div className="sc-heading">
        <h3>{t(heading)}</h3>
        <button type="button" onClick={props.onBack}>
          {t('sidechat.backToThread')}
        </button>
      </div>
      {related ? (
        <div className="sc-search-scope">
          <blockquote>{props.quote}</blockquote>
          <button type="button" onClick={widen}>
            {t('sidechat.searchAll')}
          </button>
        </div>
      ) : (
        <>
          <input
            type="search"
            aria-label={t('sidechat.search')}
            placeholder={t('sidechat.search')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <SearchFilters known={search.page.items} filter={filter} change={setFilter} />
        </>
      )}
      <SearchResults search={search} pick={setPick} />
    </div>
  );
}
function searchHeading(related: boolean) {
  return related ? 'sidechat.related' : 'sidechat.all';
}
function SearchFilters({
  known,
  filter,
  change
}: {
  known: SidechatSearchHit[];
  filter: Filter;
  change: (filter: Filter) => void;
}) {
  const { t } = useI18n();
  const choices = options(known);
  const update = (key: keyof Filter, value: string) => change({ ...filter, [key]: value });
  return (
    <details className="sc-filters">
      <summary>{t('sidechat.filters')}</summary>
      <label>
        {t('sidechat.session')}
        <select value={filter.scope} onChange={(e) => update('scope', e.target.value)}>
          <option value="">{t('sidechat.anySession')}</option>
          {[...choices.sessions].map(([id, title]) => (
            <option value={id} key={id}>
              {title}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('sidechat.bot')}
        <select value={filter.bot} onChange={(e) => update('bot', e.target.value)}>
          <option value="">{t('sidechat.anyBot')}</option>
          {choices.bots.map((id) => (
            <option value={id} key={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('sidechat.from')}
        <input type="date" value={filter.from ?? ''} onChange={(e) => update('from', e.target.value)} />
      </label>
      <label>
        {t('sidechat.until')}
        <input type="date" value={filter.to ?? ''} onChange={(e) => update('to', e.target.value)} />
      </label>
    </details>
  );
}
function SearchResults({ search, pick }: { search: ReturnType<typeof useSearchPage>; pick: (p: Pick) => void }) {
  const { t } = useI18n();
  if (search.phase === 'error') return <LoadError retry={search.retry} />;
  if (!search.page.items.length) return <NoResults busy={search.phase === 'busy'} />;
  return (
    <div className="sc-results" data-sidechat-scroll>
      {search.page.items.map((hit) => (
        <SearchRow key={hit.thread.id} hit={hit} pick={pick} />
      ))}
      {search.page.nextCursor != null && (
        <button type="button" disabled={search.phase === 'busy'} onClick={search.more}>
          {t('sidechat.more')}
        </button>
      )}
    </div>
  );
}
function NoResults({ busy }: { busy: boolean }) {
  const { t } = useI18n();
  return busy ? <Loading /> : <p className="sc-note">{t('sidechat.noMatches')}</p>;
}
function SearchRow({ hit, pick }: { hit: SidechatSearchHit; pick: (p: Pick) => void }) {
  const { t, locale } = useI18n();
  const [first, ...rest] = hit.matches;
  return (
    <article className="sc-hit">
      <button type="button" onClick={() => pick({ hit, messageId: first?.messageId })}>
        <small>
          {hit.sessionTitle || hit.thread.sessionId} · {new Date(hit.thread.updatedAt).toLocaleDateString(locale)}
        </small>
        <strong>{hit.thread.title}</strong>
        <span>{first?.snippet || hit.thread.anchor.quote}</span>
        <em>{t('sidechat.preview')}</em>
      </button>
      {rest.length > 0 && (
        <details>
          <summary>{t('sidechat.otherMatches', { count: rest.length })}</summary>
          {rest.map((m, i) => (
            <button type="button" key={i} onClick={() => pick({ hit, messageId: m.messageId })}>
              {m.snippet}
            </button>
          ))}
        </details>
      )}
    </article>
  );
}
function SearchPreview({
  pick,
  back,
  open
}: {
  pick: Pick;
  back: () => void;
  open: (thread: SidechatThread) => void;
}) {
  const { t } = useI18n();
  const detail = useSidechatDetail(pick.hit.thread.id);
  return (
    <div className="sc-search">
      <div className="sc-heading">
        <h3>{t('sidechat.preview')}</h3>
        <button type="button" onClick={back}>
          {t('sidechat.results')}
        </button>
      </div>
      <div className="sc-preview-scroll" data-sidechat-scroll>
        {detail.fault ? (
          <LoadError retry={detail.refresh} />
        ) : detail.detail ? (
          <>
            <div className="sc-source">
              <small>{pick.hit.sessionTitle}</small>
              <blockquote>{detail.detail.thread.anchor.quote}</blockquote>
              <SourceLink detail={detail.detail} onOpen={open} crossSession />
            </div>
            <SidechatMessages
              messages={detail.detail.messages}
              hit={pick.messageId}
              author={detail.detail.thread.botId || detail.detail.thread.agentId}
            />
          </>
        ) : (
          <Loading />
        )}
      </div>
    </div>
  );
}

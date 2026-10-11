'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evolutionEntryVisible } from '@/lib/evolution-surface';
import { EVOLUTION_TYPES, filterEvolutionResults, type EvolutionResultType } from '@/lib/evolution-results';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { renderMarkdown } from '@/lib/markdown';
import './evolution.css';

interface ActiveWorktree {
  path: string;
  head: string;
  branch: string;
  isEvolution: boolean;
}

interface EvolutionOverview {
  activeWorktrees: ActiveWorktree[];
  latestRunLog: string | null;
  inboxHint: string | null;
  counts: Record<string, number>;
}

interface EvolutionResult {
  type: string;
  name: string;
  status: string;
  sourceTitle: string;
  sourceUrl: string;
  experimentBranch: string;
  dateUtc: string;
  merged: boolean;
  skipReason?: string;
  noOpReason?: string;
  featurePathsCount?: number;
  detectedTool: string | null;
}

const TYPE_META: Record<EvolutionResultType, { labelKey: MessageKey; cls: string; mark: string }> = {
  success: { labelKey: 'ops.evolution.typeSuccess', cls: 'ev-badge ev-badge--success', mark: '✓' },
  failure: { labelKey: 'ops.evolution.typeFailure', cls: 'ev-badge ev-badge--failure', mark: '✗' },
  skip: { labelKey: 'ops.evolution.typeSkip', cls: 'ev-badge ev-badge--skip', mark: '⊘' },
  'no-op': { labelKey: 'ops.evolution.typeNoop', cls: 'ev-badge ev-badge--noop', mark: '—' }
};

function isKnownType(type: string): type is EvolutionResultType {
  return (EVOLUTION_TYPES as readonly string[]).includes(type);
}

function shortBranch(branch: string) {
  return branch.replace('exp/evolution-', '').slice(0, 40);
}

function EvolutionHidden() {
  const { t } = useI18n();
  return (
    <main className="ev-page" data-testid="evolution-hidden">
      <h1>{t('ops.evolution.hiddenTitle')}</h1>
      <p>{t('ops.evolution.hiddenBody')}</p>
    </main>
  );
}

function EvolutionConsole() {
  const { t } = useI18n();
  const [typeFilter, setTypeFilter] = useState<EvolutionResultType | null>(null);
  const [query, setQuery] = useState('');
  const [overview, setOverview] = useState<EvolutionOverview | null>(null);
  const [results, setResults] = useState<EvolutionResult[]>([]);
  const [detail, setDetail] = useState<{ markdown: string; name: string; type: string } | null>(null);
  const [logExpanded, setLogExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/evolution/overview');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as EvolutionOverview;
      setOverview(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchResults = useCallback(async () => {
    try {
      const res = await fetch('/api/evolution/results');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { results: EvolutionResult[] };
      setResults(data.results);
    } catch {
      // non-fatal
    } finally {
      setResultsLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (r: EvolutionResult) => {
    try {
      const res = await fetch(`/api/evolution/result?type=${encodeURIComponent(r.type)}&name=${encodeURIComponent(r.name)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { markdown: string; type: string; name: string };
      setDetail(data);
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (e) {
      setDetail({
        markdown: t('ops.evolution.detailFailed', { message: e instanceof Error ? e.message : String(e) }),
        type: r.type,
        name: r.name
      });
    }
  }, [t]);

  useEffect(() => {
    void fetchOverview();
    void fetchResults();
    const timer = setInterval(() => void fetchOverview(), 8000);
    return () => clearInterval(timer);
  }, [fetchOverview, fetchResults]);

  const visible = useMemo(
    () => filterEvolutionResults(results, { type: typeFilter, query }),
    [results, typeFilter, query]
  );

  return (
    <div className="ev-page">
      <a href="/#/ops/health" className="ev-back">
        ← {t('ops.evolution.back')}
      </a>

      <div className="ev-header">
        <h1>{t('ops.evolution.title')}</h1>
        {overview?.inboxHint ? (
          <span className="ev-count-chip">{t('ops.evolution.inbox', { hint: overview.inboxHint })}</span>
        ) : null}
        {loading ? <span className="muted">{t('ops.evolution.loading')}</span> : null}
        {err ? <span className="ev-error">{err}</span> : null}
      </div>

      <div className="ev-section">
        <p className="ev-section-title">
          {t('ops.evolution.activeTitle')}
          <span className="ev-hint">{t('ops.evolution.activeHint')}</span>
        </p>
        {!overview ? null : overview.activeWorktrees.length === 0 ? (
          <p className="ev-empty">{t('ops.evolution.activeEmpty')}</p>
        ) : (
          <>
            <p className="ev-empty">{t('ops.evolution.activeSummary', { n: overview.activeWorktrees.length })}</p>
            <div className="ev-wt-list">
              {overview.activeWorktrees.map((wt, i) => (
                <div key={i} className="ev-wt-item">
                  <div className="ev-wt-branch">{wt.branch}</div>
                  <div className="ev-wt-path">{wt.path}</div>
                  <div className="ev-wt-head">HEAD {wt.head.slice(0, 12)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {overview?.latestRunLog ? (
        <div className="ev-section">
          <p className="ev-section-title">{t('ops.evolution.logTitle')}</p>
          <div className="ev-log-wrap">
            <pre className={`ev-log${logExpanded ? '' : ' ev-log--collapsed'}`}>{overview.latestRunLog}</pre>
            {!logExpanded && <div className="ev-log-fade" />}
          </div>
          <button type="button" className="ev-log-toggle" onClick={() => setLogExpanded((v) => !v)}>
            {logExpanded ? t('ops.evolution.logCollapse') : t('ops.evolution.logExpand')}
          </button>
        </div>
      ) : null}

      <div className="ev-section">
        <p className="ev-section-title">
          {t('ops.evolution.resultsTitle')}
          <span className="ev-hint">{t('ops.evolution.resultsHint')}</span>
        </p>
        <div className="ev-filters" role="group" aria-label={t('ops.evolution.countsAria')}>
          <button
            type="button"
            className="ev-filter"
            aria-pressed={typeFilter === null}
            onClick={() => setTypeFilter(null)}
          >
            {t('ops.evolution.filterAll')} · {results.length}
          </button>
          {EVOLUTION_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={`ev-filter ev-count-chip--${type === 'no-op' ? 'noop' : type}`}
              aria-pressed={typeFilter === type}
              onClick={() => setTypeFilter(typeFilter === type ? null : type)}
            >
              {t(TYPE_META[type].labelKey)} · {overview?.counts[type] ?? 0}
            </button>
          ))}
          <input
            type="search"
            className="ev-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ops.evolution.searchPh')}
            aria-label={t('ops.evolution.searchLabel')}
            autoComplete="off"
          />
          {typeFilter || query.trim() ? (
            <span className="muted">
              {t('ops.evolution.resultsShowing', { shown: visible.length, total: results.length })}
            </span>
          ) : null}
        </div>
        {resultsLoading ? (
          <p className="ev-empty">{t('ops.evolution.loading')}</p>
        ) : results.length === 0 ? (
          <p className="ev-empty">{t('ops.evolution.resultsEmpty')}</p>
        ) : visible.length === 0 ? (
          <p className="ev-empty" data-testid="ev-no-match">
            {t('ops.evolution.resultsNoMatch')}
          </p>
        ) : (
          <div className="ev-table-wrap">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>{t('ops.evolution.colStatus')}</th>
                  <th>{t('ops.evolution.colTitle')}</th>
                  <th>{t('ops.evolution.colBranch')}</th>
                  <th>{t('ops.evolution.colTime')}</th>
                  <th>{t('ops.evolution.colTool')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const meta = isKnownType(r.type) ? TYPE_META[r.type] : null;
                  const isSelected = detail?.name === r.name && detail?.type === r.type;
                  return (
                    <tr
                      key={`${r.type}-${r.name}-${i}`}
                      className={`ev-clickable${isSelected ? ' ev-selected' : ''}`}
                      onClick={() => void openDetail(r)}
                    >
                      <td>
                        <span className={meta?.cls ?? 'ev-badge'}>
                          {meta ? `${meta.mark} ${t(meta.labelKey)}` : r.type}
                        </span>
                        {r.merged ? <span className="ev-merged">{t('ops.evolution.merged')}</span> : null}
                      </td>
                      <td className="ev-title-cell" title={r.sourceTitle}>
                        {r.sourceTitle || r.name}
                      </td>
                      <td className="ev-branch-cell" title={r.experimentBranch}>
                        {shortBranch(r.experimentBranch) || '—'}
                      </td>
                      <td className="ev-date-cell">{r.dateUtc ? r.dateUtc.slice(0, 16).replace('T', ' ') : '—'}</td>
                      <td className="ev-tool-cell">
                        {r.detectedTool ? (
                          <span className="ev-tool-tag">{r.detectedTool}</span>
                        ) : (
                          <span style={{ color: 'var(--muted)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail ? (
        <div className="ev-detail" ref={detailRef}>
          <div className="ev-detail-header">
            <span className="ev-detail-title">{detail.name}</span>
            <button
              type="button"
              className="ev-detail-close"
              aria-label={t('ops.evolution.detailClose')}
              onClick={() => setDetail(null)}
            >
              ×
            </button>
          </div>
          <div
            className="ev-detail-body"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.markdown) }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function EvolutionPage() {
  if (!evolutionEntryVisible()) return <EvolutionHidden />;
  return <EvolutionConsole />;
}

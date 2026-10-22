'use client';

import { useMemo, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { SessionSummary } from '@/lib/types';
import { filterSessions } from '@/lib/ops-health';
import { groupSessionsByDate, type SessionDateBucket } from '@/lib/session-groups';
import { formatCompactTokens, formatCostUsd, formatElapsedMs } from '@/lib/session-chrome';
import { filterTraceGroups, groupTraceEvents, summarizeTrace } from '@/lib/trace-groups';
import { EmptyState } from './ui';
import { TraceTurnList, type BulkOpen } from './TraceTurnList';
import { TrajectoryPanel } from './TrajectoryPanel';

type TraceView = 'trace' | 'eventlog';

function dateGroupLabel(
  bucket: SessionDateBucket,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  if (bucket.startsWith('m:')) {
    const [year, month] = bucket.slice(2).split('-');
    return t('ops.sessionMonth', { year, month: Number(month) });
  }
  switch (bucket) {
    case 'today':
      return t('ops.today');
    case 'yesterday':
      return t('ops.yesterday');
    case 'week':
      return t('ops.week');
    case 'month':
      return t('ops.month');
    case 'older':
      return t('ops.older');
    default:
      return t('ops.older');
  }
}

export interface OpsPanelProps {
  active: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  traceRows: { kind: string; ts: string; payload?: unknown }[];
  omittedEarlier?: number;
  traceError: boolean;
  traceLoaded: boolean;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'err' }) {
  return (
    <div className={`ops-stat${tone === 'err' ? ' ops-stat--err' : ''}`}>
      <div className="ops-stat__value">{value}</div>
      <div className="ops-stat__label">{label}</div>
    </div>
  );
}

export function OpsPanel({
  active,
  sessions,
  selectedSessionId,
  onSelectSession,
  traceRows,
  omittedEarlier = 0,
  traceError,
  traceLoaded
}: OpsPanelProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<TraceView>('trace');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [kindQuery, setKindQuery] = useState('');
  const [bulk, setBulk] = useState<BulkOpen>({ version: 0, open: false });

  const filtered = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);
  const groups = useMemo(() => groupSessionsByDate(filtered), [filtered]);
  const turns = useMemo(() => groupTraceEvents(traceRows), [traceRows]);
  const overview = useMemo(() => summarizeTrace(turns), [turns]);
  const visibleTurns = useMemo(
    () => filterTraceGroups(turns, { errorsOnly, query: kindQuery }),
    [turns, errorsOnly, kindQuery]
  );
  const selected = sessions.find((s) => s.id === selectedSessionId) ?? null;
  const traceFiltered = errorsOnly || kindQuery.trim() !== '';

  const clearTraceFilters = () => {
    setErrorsOnly(false);
    setKindQuery('');
  };

  const renderTraceBody = () => {
    if (!selectedSessionId) {
      return <EmptyState title={t('ops.emptyPickSession')} />;
    }
    if (traceError && turns.length === 0) {
      return <p role="alert">{t('ops.traceLoadFailed')}</p>;
    }
    if (!traceLoaded) {
      return <p className="muted">{t('ops.traceLoading')}</p>;
    }
    if (!turns.length) {
      return <EmptyState title={t('ops.emptyTraj')} />;
    }
    if (!visibleTurns.length) {
      const onlyErrorsEmpty = errorsOnly && kindQuery.trim() === '';
      return (
        <>
          {traceError ? <p role="alert">{t('ops.traceLoadFailed')}</p> : null}
          <EmptyState
            title={onlyErrorsEmpty ? t('ops.trace.noErrorTurns') : t('ops.trace.noMatchEvents')}
            description={onlyErrorsEmpty ? t('ops.trace.noErrorTurnsHint') : t('ops.trace.noMatchEventsHint')}
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearTraceFilters}>
                {t('ops.trace.clearFilters')}
              </button>
            }
          />
        </>
      );
    }
    return (
      <>
        {traceError ? <p role="alert">{t('ops.traceLoadFailed')}</p> : null}
        <TraceTurnList groups={visibleTurns} bulk={bulk} />
      </>
    );
  };

  return (
    <section
      className={`panel ${active ? 'active' : ''}`}
      id="panel-ops"
      role="tabpanel"
      hidden={!active}
      inert={!active}
    >
      <div className="ops-traj">
        <div className="card ops-traj__sessions">
          <div className="card-head">
            <h3>{t('ops.sessions')}</h3>
            <span className="badge" id="countSessions">
              {filtered.length}
            </span>
          </div>
          <label className="field" style={{ margin: '0 0 8px' }}>
            <span className="sr-only">{t('ops.filterSessions')}</span>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('ops.filterPh')}
              autoComplete="off"
            />
          </label>
          <div className="list-scroll tall" id="listSessions">
            {!sessions.length ? (
              <div className="empty-hint">{t('ops.emptySessions')}</div>
            ) : !filtered.length ? (
              <EmptyState
                title={t('ops.noMatchSessions')}
                description={t('ops.noMatchSessionsHint')}
                action={
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilter('')}>
                    {t('ops.clearFilter')}
                  </button>
                }
              />
            ) : (
              groups.map((g) => (
                <section key={g.bucket} className="session-date-group">
                  <h4 className="session-date-group__label">{dateGroupLabel(g.bucket, t)}</h4>
                  <div className="session-date-group__items">
                    {g.sessions.map((s) => (
                      <div
                        key={s.id}
                        className={`list-item list-item--session ${selectedSessionId === s.id ? 'selected' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-current={selectedSessionId === s.id ? 'true' : undefined}
                        onClick={() => onSelectSession(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectSession(s.id);
                          }
                        }}
                      >
                        <div className="session-item__title">{s.title || t('ops.untitled')}</div>
                        <div className="session-item__meta">
                          <span>
                            {s.agentId || '—'} · {s.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>

        <div className="card ops-traj__trace">
          <div className="card-head">
            <h3>{t('ops.trajectory')}</h3>
            {selected ? (
              <span className="muted ops-traj__current" title={selected.id}>
                {selected.title || selected.id}
              </span>
            ) : null}
            <div className="ops-viewtabs" role="tablist" aria-label={t('ops.trace.viewTabs')}>
              {(['trace', 'eventlog'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={`ops-viewtab${view === v ? ' is-active' : ''}`}
                  onClick={() => setView(v)}
                >
                  {v === 'trace' ? t('ops.trace.viewTrace') : t('ops.trace.viewEventLog')}
                </button>
              ))}
            </div>
          </div>

          {view === 'eventlog' ? (
            <div className="trace-timeline" id="traceTimeline">
              <TrajectoryPanel sessionId={selectedSessionId} />
            </div>
          ) : (
            <>
              {selectedSessionId && turns.length ? (
                <div className="ops-stats" role="group" aria-label={t('ops.trace.overviewAria')} data-testid="trace-overview">
                  <Stat label={t('ops.trace.statTurns')} value={String(overview.turns)} />
                  <Stat
                    label={t('ops.trace.statErrors')}
                    value={String(overview.errorTurns)}
                    tone={overview.errorTurns > 0 ? 'err' : undefined}
                  />
                  <Stat label={t('ops.trace.statDuration')} value={formatElapsedMs(overview.totalDurationMs)} />
                  <Stat label={t('ops.trace.statTools')} value={String(overview.toolCalls)} />
                  {overview.totalTokens != null ? (
                    <Stat label={t('ops.trace.statTokens')} value={formatCompactTokens(overview.totalTokens)} />
                  ) : null}
                  {overview.costUsd != null ? (
                    <Stat label={t('ops.trace.statCost')} value={formatCostUsd(overview.costUsd)} />
                  ) : null}
                </div>
              ) : null}

              {selectedSessionId && turns.length ? (
                <div className="ops-toolbar">
                  <label className="toggle toggle--compact">
                    <input
                      type="checkbox"
                      checked={errorsOnly}
                      onChange={(e) => setErrorsOnly(e.target.checked)}
                    />
                    <span>{t('ops.trace.onlyErrors')}</span>
                  </label>
                  <label className="field ops-toolbar__search">
                    <span className="sr-only">{t('ops.trace.kindFilter')}</span>
                    <input
                      type="search"
                      value={kindQuery}
                      onChange={(e) => setKindQuery(e.target.value)}
                      placeholder={t('ops.trace.kindFilterPh')}
                      autoComplete="off"
                    />
                  </label>
                  <span className="ops-toolbar__spacer" />
                  {traceFiltered ? (
                    <span className="muted small">
                      {t('ops.trace.showing', { shown: visibleTurns.length, total: turns.length })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setBulk((b) => ({ version: b.version + 1, open: true }))}
                  >
                    {t('ops.trace.expandAll')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setBulk((b) => ({ version: b.version + 1, open: false }))}
                  >
                    {t('ops.trace.collapseAll')}
                  </button>
                </div>
              ) : null}

              <p className="muted small">
                {t('ops.trajHint')} · {t('ops.trace.autoRefresh')}
              </p>
              {omittedEarlier > 0 ? (
                <p className="ops-trace-omitted" role="status" data-testid="trace-earlier-hidden">
                  {t('ops.trace.earlierHidden', { n: omittedEarlier })}
                </p>
              ) : null}
              <div className="trace-timeline" id="traceTimeline">
                {renderTraceBody()}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { EmptyState, SettingsGroup } from './ui';
import { ListFallback } from './sections/tasks/ListFallback';
import { StatusFilterBar } from './sections/tasks/StatusFilterBar';
import { RUN_STATUSES, countByStatus, filterByStatusAndQuery, type StatusFilter } from './sections/tasks/task-filters';
import styles from './sections/tasks/tasks.module.css';

export type OrchestrationRunRow = {
  id: string;
  title: string;
  status: string;
  riskLevel?: string;
};

type RunStatusId = (typeof RUN_STATUSES)[number];

export function OrchestrationPanel({ runs, loadError = false }: { runs: OrchestrationRunRow[]; loadError?: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusFilter<RunStatusId>>('all');
  const [query, setQuery] = useState('');
  const counts = useMemo(() => countByStatus(runs, RUN_STATUSES), [runs]);
  const visible = useMemo(
    () => filterByStatusAndQuery(runs, { status, query }, (r) => [r.title, r.id]),
    [runs, status, query]
  );
  const statusLabel = (s: StatusFilter<RunStatusId> | string) =>
    s === 'all' || (RUN_STATUSES as readonly string[]).includes(s)
      ? t(s === 'all' ? 'tasks.status.all' : (`tasks.runStatus.${s}` as MessageKey))
      : s;

  return (
    <SettingsGroup title={t('tasks.runs.title')} description={t('tasks.runs.desc')}>
      <ListFallback
        error={loadError}
        count={runs.length}
        empty={<EmptyState title={t('tasks.runs.emptyTitle')} description={t('tasks.runs.emptyDesc')} />}
      >
        <>
          <div className={styles.toolbar}>
            <input
              id="runSearch"
              className={`input ${styles.search}`}
              type="search"
              aria-label={t('tasks.runs.searchLabel')}
              placeholder={t('tasks.runs.searchPh')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <StatusFilterBar
              id="runStatusFilter"
              statuses={RUN_STATUSES}
              active={status}
              counts={counts}
              labelOf={statusLabel}
              onChange={setStatus}
            />
          </div>
          {visible.length === 0 ? (
            <EmptyState
              title={t('tasks.runs.noMatchTitle')}
              description={t('tasks.runs.noMatchDesc')}
              action={
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setStatus('all');
                    setQuery('');
                  }}
                >
                  {t('tasks.clearFilters')}
                </button>
              }
            />
          ) : (
            <div id="listOrchestrationRuns" className={styles.list}>
              {visible.map((r) => (
                <div key={r.id} className={`list-item ${styles.row}`}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>{r.title}</span>
                    <span className={`${styles.status} ${styles[`status${r.status[0].toUpperCase()}${r.status.slice(1)}`] ?? ''}`}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <div className={styles.rowMeta}>
                    <span>{t('tasks.runs.risk', { level: r.riskLevel ?? '—' })}</span>
                    <span>{r.id}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      </ListFallback>
    </SettingsGroup>
  );
}

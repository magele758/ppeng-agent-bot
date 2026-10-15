'use client';

import { useMemo, useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { EmptyState, SettingsGroup } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import { ListFallback } from './ListFallback';
import { StatusFilterBar } from './StatusFilterBar';
import { TASK_STATUSES, countByStatus, filterByStatusAndQuery, type StatusFilter } from './task-filters';
import styles from './tasks.module.css';

type TaskStatusId = (typeof TASK_STATUSES)[number];

export function TaskQueueView() {
  const { t } = useI18n();
  const { tasks, socialSchedules, jobs, listState, openSession } = useLab();
  const [status, setStatus] = useState<StatusFilter<TaskStatusId>>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => countByStatus(tasks, TASK_STATUSES), [tasks]);
  const visible = useMemo(
    () => filterByStatusAndQuery(tasks, { status, query }, (task) => [task.title, task.ownerAgentId]),
    [tasks, status, query]
  );
  const statusLabel = (s: StatusFilter<TaskStatusId>) => t(`tasks.status.${s}` as MessageKey);
  const clearFilters = () => {
    setStatus('all');
    setQuery('');
  };

  return (
    <>
      <SettingsGroup title={t('tasks.queue.tasksTitle')} description={t('tasks.queue.tasksDesc')}>
        <ListFallback
          error={listState.tasks.error}
          count={tasks.length}
          empty={<EmptyState title={t('tasks.queue.emptyTitle')} description={t('tasks.queue.emptyDesc')} />}
        >
          <>
            <div className={styles.toolbar}>
              <input
                id="taskSearch"
                className={`input ${styles.search}`}
                type="search"
                aria-label={t('tasks.queue.searchLabel')}
                placeholder={t('tasks.queue.searchPh')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <StatusFilterBar
                id="taskStatusFilter"
                statuses={TASK_STATUSES}
                active={status}
                counts={counts}
                labelOf={statusLabel}
                onChange={setStatus}
              />
            </div>
            {visible.length === 0 ? (
              <EmptyState
                title={t('tasks.queue.noMatchTitle')}
                description={t('tasks.queue.noMatchDesc')}
                action={
                  <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                    {t('tasks.clearFilters')}
                  </button>
                }
              />
            ) : (
              <div id="listTasks" className={styles.list}>
                {visible.map((task, i) => (
                  <div key={`${task.title}-${i}`} className={`list-item ${styles.row}`}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{task.title}</span>
                      <span className={`${styles.status} ${styles[`status${task.status[0].toUpperCase()}${task.status.slice(1)}`] ?? ''}`}>
                        {statusLabel(task.status)}
                      </span>
                    </div>
                    <div className={styles.rowMeta}>
                      <span>
                        {task.ownerAgentId
                          ? t('tasks.queue.owner', { agent: task.ownerAgentId })
                          : t('tasks.queue.unassigned')}
                      </span>
                      {task.sessionId ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void openSession(task.sessionId as string, { focusChat: true })}
                        >
                          {t('tasks.openSession')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        </ListFallback>
      </SettingsGroup>

      <SettingsGroup title={t('tasks.queue.schedulesTitle')} description={t('tasks.queue.schedulesDesc')} collapsible>
        <ListFallback
          error={listState.socialSchedules.error}
          count={socialSchedules.length}
          empty={<EmptyState title={t('tasks.queue.schedulesEmptyTitle')} description={t('tasks.queue.schedulesEmptyDesc')} />}
        >
          <div id="listSchedules" className={styles.list}>
            {socialSchedules.map((s) => (
              <div key={s.taskId} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{s.title}</span>
                  <span className={styles.status}>{statusLabel(s.status)}</span>
                </div>
                <div className={styles.rowMeta}>
                  <span>{s.publishAt}</span>
                  <span>{s.channels.join(', ')}</span>
                </div>
              </div>
            ))}
          </div>
        </ListFallback>
      </SettingsGroup>

      <SettingsGroup title={t('tasks.queue.jobsTitle')} description={t('tasks.queue.jobsDesc')} collapsible>
        <ListFallback
          error={listState.jobs.error}
          count={jobs.length}
          empty={<EmptyState title={t('tasks.queue.jobsEmptyTitle')} description={t('tasks.queue.jobsEmptyDesc')} />}
        >
          <div id="listJobs" className={styles.list}>
            {jobs.map((j, i) => (
              <div key={`job-${i}-${j.command ?? ''}`} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{j.command || t('tasks.queue.unnamedJob')}</span>
                  {j.status ? <span className={styles.status}>{j.status}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </ListFallback>
      </SettingsGroup>
    </>
  );
}

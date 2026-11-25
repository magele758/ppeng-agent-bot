'use client';

import { useMemo, useState } from 'react';
import { stepItemId } from '@/lib/bot-tasks-view';
import { useI18n } from '@/lib/i18n';
import { buildBotNameMap, matchesQueueQuery, type QueueScope } from '@/lib/task-queue-view';
import type { TaskSummary } from '@/lib/types';
import { useLab } from '../../shell/LabProvider';
import { TASK_STATUSES, countByStatus, type StatusFilter } from './task-filters';
import { TaskQueueDetailPane } from './TaskQueueDetailPane';
import { TaskQueueListPane, type TaskStatusId } from './TaskQueueListPane';
import {
  buildVisibleQueueItems,
  groupIndexedTasks,
  jobRowKey,
  matchesJobQuery,
  matchesScheduleQuery,
  resolveActiveSelectionKey,
  taskRowKey,
  type IndexedJob,
  type IndexedTask
} from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

function filterTaskEntries(
  tasks: readonly TaskSummary[],
  status: StatusFilter<TaskStatusId>,
  query: string,
  botNameMap: ReadonlyMap<string, string>
): IndexedTask[] {
  const indexed: IndexedTask[] = tasks.map((task, index) => ({ key: taskRowKey(task, index), index, task }));
  return indexed.filter(
    ({ task }) => (status === 'all' || task.status === status) && matchesQueueQuery(task, query, botNameMap)
  );
}

export function TaskQueueView() {
  const { t } = useI18n();
  const { tasks, socialSchedules, jobs, bots, listState, openSession, loadOverview } = useLab();
  const [scope, setScope] = useState<QueueScope>('all');
  const [status, setStatus] = useState<StatusFilter<TaskStatusId>>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const botNameMap = useMemo(() => buildBotNameMap(bots), [bots]);
  const statusCounts = useMemo(() => countByStatus(tasks, TASK_STATUSES), [tasks]);
  const visibleTasks = useMemo(
    () => filterTaskEntries(tasks, status, query, botNameMap),
    [tasks, status, query, botNameMap]
  );
  const groupedTasks = useMemo(() => groupIndexedTasks(visibleTasks), [visibleTasks]);
  const visibleSchedules = useMemo(
    () => socialSchedules.filter((item) => matchesScheduleQuery(item, query)),
    [socialSchedules, query]
  );
  const visibleJobs = useMemo<IndexedJob[]>(() => {
    const fallback = t('tasks.queue.unnamedJob');
    return jobs
      .map((job, index) => ({ key: jobRowKey(job, index), index, job }))
      .filter(({ job }) => matchesJobQuery(job, query, fallback));
  }, [jobs, query, t]);

  const visibleItems = useMemo(
    () => buildVisibleQueueItems(scope, groupedTasks, visibleSchedules, visibleJobs),
    [scope, groupedTasks, visibleSchedules, visibleJobs]
  );
  const visibleKeys = useMemo(() => visibleItems.map((item) => item.key), [visibleItems]);
  const activeKey = useMemo(
    () => resolveActiveSelectionKey(visibleKeys, selectedKey, dismissed),
    [visibleKeys, selectedKey, dismissed]
  );
  const selectedItem = useMemo(
    () => visibleItems.find((item) => item.key === activeKey) ?? null,
    [visibleItems, activeKey]
  );

  const prevKey = stepItemId(visibleKeys, activeKey, -1);
  const nextKey = stepItemId(visibleKeys, activeKey, 1);

  const handleSelect = (key: string) => {
    setSelectedKey(key);
    setDismissed(false);
  };
  const handleStep = (delta: -1 | 1) => {
    const target = stepItemId(visibleKeys, activeKey, delta);
    if (target) handleSelect(target);
  };
  const handleClose = () => {
    setSelectedKey(null);
    setDismissed(true);
  };
  const handleClearFilters = () => {
    setStatus('all');
    setQuery('');
  };
  const handleOpenSession = (sessionId: string) => {
    void openSession(sessionId, { focusChat: true });
  };

  return (
    <div className={styles.shell} data-testid="task-queue-master-detail">
      <TaskQueueListPane
        scope={scope}
        onScopeChange={setScope}
        query={query}
        onQueryChange={setQuery}
        status={status}
        onStatusChange={setStatus}
        statusCounts={statusCounts}
        totalCounts={{ tasks: tasks.length, schedules: socialSchedules.length, jobs: jobs.length }}
        visibleTaskCount={visibleTasks.length}
        groupedTasks={groupedTasks}
        schedules={visibleSchedules}
        jobs={visibleJobs}
        bots={bots}
        listState={listState}
        selectedKey={activeKey}
        onSelect={handleSelect}
        onClearFilters={handleClearFilters}
      />
      <TaskQueueDetailPane
        item={selectedItem}
        bots={bots}
        hasPrev={Boolean(prevKey)}
        hasNext={Boolean(nextKey)}
        onStep={handleStep}
        onClose={handleClose}
        onOpenSession={handleOpenSession}
        onRefresh={loadOverview}
      />
    </div>
  );
}

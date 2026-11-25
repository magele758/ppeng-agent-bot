'use client';

import { useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { QUEUE_BAND_ORDER, type QueuePriorityBand, type QueueScope } from '@/lib/task-queue-view';
import type { BotInfo, SocialPostScheduleItem } from '@/lib/types';
import type { LabListState } from '@/lib/list-load';
import type { JobRow } from '../../shell/LabProvider';
import { ListFallback } from './ListFallback';
import { StatusFilterBar } from './StatusFilterBar';
import { TASK_STATUSES, type StatusFilter } from './task-filters';
import { TaskQueueJobRow, TaskQueueScheduleRow, TaskQueueTaskRow } from './TaskQueueRow';
import {
  BAND_LABEL_KEYS,
  scheduleRowKey,
  scopeVisibility,
  type IndexedJob,
  type IndexedTask
} from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

export type TaskStatusId = (typeof TASK_STATUSES)[number];

type BandDotTone = QueuePriorityBand | 'schedule' | 'job';

const BAND_DOT_CLASS: Readonly<Record<BandDotTone, string>> = {
  attention: styles.bandDotAttention,
  active: styles.bandDotActive,
  pending: styles.bandDotPending,
  done: styles.bandDotDone,
  schedule: styles.bandDotSchedule,
  job: styles.bandDotJob
};

function ScopeTabs({
  scope,
  counts,
  onChange
}: {
  scope: QueueScope;
  counts: { all: number; tasks: number; schedules: number; jobs: number };
  onChange: (scope: QueueScope) => void;
}) {
  const { t } = useI18n();
  const tabs: ReadonlyArray<{ id: QueueScope; label: string; count: number }> = [
    { id: 'all', label: t('tasks.queue.scopeAll'), count: counts.all },
    { id: 'tasks', label: t('tasks.queue.scopeTasks'), count: counts.tasks },
    { id: 'schedules', label: t('tasks.queue.scopeSchedules'), count: counts.schedules },
    { id: 'jobs', label: t('tasks.queue.scopeJobs'), count: counts.jobs }
  ];

  return (
    <div className={styles.scopeBar} role="group" aria-label={t('tasks.queue.tasksTitle')}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={`queue-scope-${tab.id}`}
          aria-pressed={scope === tab.id}
          className={scope === tab.id ? `${styles.scopeTab} ${styles.scopeTabActive}` : styles.scopeTab}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          <span className={styles.scopeCount}>{tab.count}</span>
        </button>
      ))}
    </div>
  );
}

function BandHeader({
  label,
  count,
  tone,
  collapsed,
  onToggle
}: {
  label: string;
  count: number;
  tone: BandDotTone;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={styles.bandHeader} aria-expanded={!collapsed} onClick={onToggle}>
      <span className={styles.bandHeaderLeft}>
        <span className={`${styles.bandDot} ${BAND_DOT_CLASS[tone]}`} aria-hidden="true" />
        <span>{label}</span>
        <span className={styles.bandCount}>{count}</span>
      </span>
      <span
        className={collapsed ? `${styles.bandChevron} ${styles.bandChevronCollapsed}` : styles.bandChevron}
        aria-hidden="true"
      >
        ▾
      </span>
    </button>
  );
}

function BandEmpty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className={styles.bandEmpty}>
      <p className={styles.bandEmptyTitle}>{title}</p>
      <p className={styles.bandEmptyDesc}>{description}</p>
      {action ?? null}
    </div>
  );
}

function PriorityBandGroup({
  band,
  items,
  bots,
  selectedKey,
  collapsed,
  onToggle,
  onSelect
}: {
  band: QueuePriorityBand;
  items: readonly IndexedTask[];
  bots: readonly BotInfo[];
  selectedKey: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;

  return (
    <div className={styles.bandGroup} data-testid={`queue-band-${band}`}>
      <BandHeader
        label={t(BAND_LABEL_KEYS[band])}
        count={items.length}
        tone={band}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {collapsed ? null : (
        <div className={styles.bandList}>
          {items.map((entry) => (
            <TaskQueueTaskRow
              key={entry.key}
              task={entry.task}
              bots={bots}
              selected={selectedKey === entry.key}
              onSelect={() => onSelect(entry.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskBandSection({
  totalCount,
  visibleCount,
  groupedTasks,
  error,
  bots,
  selectedKey,
  collapsedMap,
  onToggleBand,
  onSelect,
  onClearFilters
}: {
  totalCount: number;
  visibleCount: number;
  groupedTasks: Record<QueuePriorityBand, IndexedTask[]>;
  error: boolean;
  bots: readonly BotInfo[];
  selectedKey: string | null;
  collapsedMap: Readonly<Record<string, boolean>>;
  onToggleBand: (id: string) => void;
  onSelect: (key: string) => void;
  onClearFilters: () => void;
}) {
  const { t } = useI18n();
  const clearAction = (
    <button type="button" className={styles.clearBtn} onClick={onClearFilters}>
      {t('tasks.clearFilters')}
    </button>
  );

  return (
    <section className={styles.sectionBlock} aria-label={t('tasks.queue.tasksTitle')}>
      <ListFallback
        error={error}
        count={totalCount}
        empty={<BandEmpty title={t('tasks.queue.emptyTitle')} description={t('tasks.queue.emptyDesc')} />}
      >
        {visibleCount === 0 ? (
          <BandEmpty
            title={t('tasks.queue.noMatchTitle')}
            description={t('tasks.queue.noMatchDesc')}
            action={clearAction}
          />
        ) : (
          <div id="listTasks" className={styles.sectionBlock}>
            {QUEUE_BAND_ORDER.map((band) => (
              <PriorityBandGroup
                key={band}
                band={band}
                items={groupedTasks[band]}
                bots={bots}
                selectedKey={selectedKey}
                collapsed={Boolean(collapsedMap[`task-${band}`])}
                onToggle={() => onToggleBand(`task-${band}`)}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </ListFallback>
    </section>
  );
}

function ScheduleBandSection({
  totalCount,
  schedules,
  error,
  selectedKey,
  collapsed,
  onToggle,
  onSelect
}: {
  totalCount: number;
  schedules: readonly SocialPostScheduleItem[];
  error: boolean;
  selectedKey: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();

  return (
    <section className={styles.sectionBlock} aria-label={t('tasks.queue.schedulesTitle')}>
      <BandHeader
        label={t('tasks.queue.schedulesTitle')}
        count={schedules.length}
        tone="schedule"
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {collapsed ? null : (
        <ListFallback
          error={error}
          count={totalCount}
          empty={
            <BandEmpty title={t('tasks.queue.schedulesEmptyTitle')} description={t('tasks.queue.schedulesEmptyDesc')} />
          }
        >
          {schedules.length === 0 ? (
            <p className={styles.mutedNote}>{t('tasks.queue.noMatchDesc')}</p>
          ) : (
            <div id="listSchedules" className={styles.bandList}>
              {schedules.map((schedule) => {
                const key = scheduleRowKey(schedule);
                return (
                  <TaskQueueScheduleRow
                    key={key}
                    schedule={schedule}
                    selected={selectedKey === key}
                    onSelect={() => onSelect(key)}
                  />
                );
              })}
            </div>
          )}
        </ListFallback>
      )}
    </section>
  );
}

function JobBandSection({
  totalCount,
  jobs,
  error,
  selectedKey,
  collapsed,
  onToggle,
  onSelect
}: {
  totalCount: number;
  jobs: readonly IndexedJob[];
  error: boolean;
  selectedKey: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (key: string) => void;
}) {
  const { t } = useI18n();

  return (
    <section className={styles.sectionBlock} aria-label={t('tasks.queue.jobsTitle')}>
      <BandHeader
        label={t('tasks.queue.jobsTitle')}
        count={jobs.length}
        tone="job"
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {collapsed ? null : (
        <ListFallback
          error={error}
          count={totalCount}
          empty={<BandEmpty title={t('tasks.queue.jobsEmptyTitle')} description={t('tasks.queue.jobsEmptyDesc')} />}
        >
          {jobs.length === 0 ? (
            <p className={styles.mutedNote}>{t('tasks.queue.noMatchDesc')}</p>
          ) : (
            <div id="listJobs" className={styles.bandList}>
              {jobs.map((entry) => (
                <TaskQueueJobRow
                  key={entry.key}
                  job={entry.job}
                  selected={selectedKey === entry.key}
                  onSelect={() => onSelect(entry.key)}
                />
              ))}
            </div>
          )}
        </ListFallback>
      )}
    </section>
  );
}

export interface TaskQueueListPaneProps {
  scope: QueueScope;
  onScopeChange: (scope: QueueScope) => void;
  query: string;
  onQueryChange: (query: string) => void;
  status: StatusFilter<TaskStatusId>;
  onStatusChange: (status: StatusFilter<TaskStatusId>) => void;
  statusCounts: Record<StatusFilter<TaskStatusId>, number>;
  totalCounts: { tasks: number; schedules: number; jobs: number };
  visibleTaskCount: number;
  groupedTasks: Record<QueuePriorityBand, IndexedTask[]>;
  schedules: readonly SocialPostScheduleItem[];
  jobs: readonly IndexedJob[];
  bots: readonly BotInfo[];
  listState: LabListState;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onClearFilters: () => void;
}

function ListScrollBody({
  props,
  collapsedMap,
  onToggleBand
}: {
  props: TaskQueueListPaneProps;
  collapsedMap: Readonly<Record<string, boolean>>;
  onToggleBand: (id: string) => void;
}) {
  const show = scopeVisibility(props.scope);
  return (
    <div className={styles.listScroll}>
      {show.tasks ? (
        <TaskBandSection
          totalCount={props.totalCounts.tasks}
          visibleCount={props.visibleTaskCount}
          groupedTasks={props.groupedTasks}
          error={props.listState.tasks.error}
          bots={props.bots}
          selectedKey={props.selectedKey}
          collapsedMap={collapsedMap}
          onToggleBand={onToggleBand}
          onSelect={props.onSelect}
          onClearFilters={props.onClearFilters}
        />
      ) : null}
      {show.schedules ? (
        <ScheduleBandSection
          totalCount={props.totalCounts.schedules}
          schedules={props.schedules}
          error={props.listState.socialSchedules.error}
          selectedKey={props.selectedKey}
          collapsed={Boolean(collapsedMap.schedules)}
          onToggle={() => onToggleBand('schedules')}
          onSelect={props.onSelect}
        />
      ) : null}
      {show.jobs ? (
        <JobBandSection
          totalCount={props.totalCounts.jobs}
          jobs={props.jobs}
          error={props.listState.jobs.error}
          selectedKey={props.selectedKey}
          collapsed={Boolean(collapsedMap.jobs)}
          onToggle={() => onToggleBand('jobs')}
          onSelect={props.onSelect}
        />
      ) : null}
    </div>
  );
}

export function TaskQueueListPane(props: TaskQueueListPaneProps) {
  const { t } = useI18n();
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});
  const toggleBand = (id: string) => setCollapsedMap((prev) => ({ ...prev, [id]: !prev[id] }));
  const statusLabel = (s: StatusFilter<TaskStatusId>) => t(`tasks.status.${s}` as MessageKey);
  const show = scopeVisibility(props.scope);

  return (
    <div className={styles.listPane} data-testid="task-queue-list-pane">
      <div className={styles.listHeader}>
        <ScopeTabs
          scope={props.scope}
          counts={{
            all: props.totalCounts.tasks + props.totalCounts.schedules + props.totalCounts.jobs,
            ...props.totalCounts
          }}
          onChange={props.onScopeChange}
        />
        <div className={styles.searchWrap}>
          <input
            id="taskSearch"
            className={styles.searchInput}
            type="search"
            aria-label={t('tasks.queue.searchLabel')}
            placeholder={t('tasks.queue.searchPh')}
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
          />
        </div>
        {show.tasks ? (
          <div className={styles.filterStrip}>
            <StatusFilterBar
              id="taskStatusFilter"
              statuses={TASK_STATUSES}
              active={props.status}
              counts={props.statusCounts}
              labelOf={statusLabel}
              onChange={props.onStatusChange}
            />
          </div>
        ) : null}
      </div>

      <ListScrollBody props={props} collapsedMap={collapsedMap} onToggleBand={toggleBand} />
    </div>
  );
}

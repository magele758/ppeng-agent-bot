'use client';

import { useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import type {
  BotCollaborationGroup,
  BotTaskBand,
  BotTaskFacetCounts,
  BotTaskFilterState,
  BotTaskItem,
  BotTaskStatusRow,
} from '@/lib/bot-tasks-view';
import { Status } from './shared';
import { BotTaskFilterPopover } from './BotTaskFilterPopover';
import { BotTaskRow } from './BotTaskRow';
import { BotCollaborationRow } from './BotCollaborationRow';
import styles from './bot-team-work.module.css';

interface BotTaskListPaneProps {
  bots: BotInfo[];
  botNameMap: ReadonlyMap<string, string>;
  statuses: BotTaskStatusRow[];
  groups: BotCollaborationGroup[];
  bands: Record<BotTaskBand, BotTaskItem[]>;
  totalStandaloneCount: number;
  filteredStandaloneCount: number;
  cursor: string | null;
  busy: boolean;
  filters: BotTaskFilterState;
  facets: BotTaskFacetCounts;
  activeFilterCount: number;
  selectedTaskId: string | null;
  selectedCollabId: string | null;
  onFiltersChange: (next: Partial<BotTaskFilterState>) => void;
  onClearFilters: () => void;
  onSelectTask: (task: BotTaskItem) => void;
  onSelectCollaboration: (groupId: string) => void;
  onCancelTask: (taskId: string) => void;
  onLoadOlder: () => void;
  onRefresh: () => void;
  onOpenDefaultBot: () => void;
}

interface BandConfig {
  band: BotTaskBand;
  labelKey: MessageKey;
  dotClass: string;
}

const PRIORITY_BAND_CONFIG: ReadonlyArray<BandConfig> = [
  { band: 'attention', labelKey: 'botWork.bandAttention', dotClass: styles.bandDotAttention },
  { band: 'active', labelKey: 'botWork.bandActive', dotClass: styles.bandDotActive },
];

const HISTORY_BAND_CONFIG: ReadonlyArray<BandConfig> = [
  { band: 'history', labelKey: 'botWork.bandHistory', dotClass: styles.bandDotHistory },
];

function CollapsibleBand({
  title,
  count,
  dotClass,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  dotClass: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={styles.band}>
      <button
        type="button"
        className={styles.bandHeader}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className={styles.bandTitleWrap}>
          <span className={`${styles.bandDot} ${dotClass}`} aria-hidden="true" />
          <span>{title}</span>
        </span>
        <span className={styles.bandCount}>
          {count} {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && <div className={styles.bandItems}>{children}</div>}
    </div>
  );
}

function ListEmptyState({
  hasAnyItems,
  hasActiveFilters,
  busy,
  onClearFilters,
}: {
  hasAnyItems: boolean;
  hasActiveFilters: boolean;
  busy: boolean;
  onClearFilters: () => void;
}) {
  const { t } = useI18n();
  if (hasAnyItems && hasActiveFilters) {
    return (
      <div className={styles.listEmpty}>
        <p>{t('botWork.noMatchingTasks')}</p>
        <button type="button" className={styles.ghostBtn} onClick={onClearFilters}>
          {t('botWork.filterClear')}
        </button>
      </div>
    );
  }
  if (!hasAnyItems && !busy) {
    return (
      <div className={styles.listEmpty}>
        <p>{t('botWork.empty')}</p>
      </div>
    );
  }
  return null;
}

function StatusRosterDrawer({
  statuses,
  busy,
  onRefresh,
  onOpenDefaultBot,
}: {
  statuses: BotTaskStatusRow[];
  busy: boolean;
  onRefresh: () => void;
  onOpenDefaultBot: () => void;
}) {
  const { t } = useI18n();
  return (
    <details className={`bot-work-more ${styles.moreDrawer}`}>
      <summary className={styles.moreSummary} data-testid="bot-work-history-toggle">
        {t('botWork.more')}
      </summary>
      <div className={styles.moreBody}>
        <div className={styles.moreActions}>
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onRefresh}>
            {t('botWork.refresh')}
          </button>
          <button type="button" className={styles.ghostBtn} disabled={busy} onClick={onOpenDefaultBot}>
            {t('botWork.defaultBot')}
          </button>
        </div>
        <h4 className={styles.rosterHeading}>{t('botWork.roster')}</h4>
        <ul className={styles.rosterList}>
          {statuses.map((row) => (
            <li role="presentation" key={row.bot.id} className={styles.rosterItem}>
              <span>{row.bot.name}</span>
              <span>
                <Status value={row.status} /> · {row.pending}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function ListHeadBar({
  bots,
  filters,
  facets,
  activeFilterCount,
  filterOpen,
  onToggleFilter,
  onCloseFilter,
  onFiltersChange,
  onClearFilters,
}: {
  bots: BotInfo[];
  filters: BotTaskFilterState;
  facets: BotTaskFacetCounts;
  activeFilterCount: number;
  filterOpen: boolean;
  onToggleFilter: () => void;
  onCloseFilter: () => void;
  onFiltersChange: (next: Partial<BotTaskFilterState>) => void;
  onClearFilters: () => void;
}) {
  const { t } = useI18n();
  const triggerClass = activeFilterCount > 0
    ? `${styles.filterTrigger} ${styles.filterTriggerActive}`
    : styles.filterTrigger;

  return (
    <div className={styles.listHead}>
      <input
        type="search"
        className={styles.searchInput}
        placeholder={t('botWork.searchPlaceholder')}
        aria-label={t('botWork.searchPlaceholder')}
        value={filters.query}
        onChange={(event) => onFiltersChange({ query: event.target.value })}
      />
      <button
        type="button"
        className={triggerClass}
        aria-expanded={filterOpen}
        onClick={onToggleFilter}
      >
        <span>{t('botWork.filterButton')}</span>
        {activeFilterCount > 0 && (
          <span
            className={styles.filterCountBadge}
            title={t('botWork.filterActiveCount', { count: activeFilterCount })}
          >
            {activeFilterCount}
          </span>
        )}
      </button>

      {filterOpen && (
        <BotTaskFilterPopover
          bots={bots}
          filters={filters}
          facets={facets}
          hasActiveFilters={activeFilterCount > 0}
          onChange={onFiltersChange}
          onClear={onClearFilters}
          onClose={onCloseFilter}
        />
      )}
    </div>
  );
}

function TaskBandSections({
  configs,
  bands,
  botNameMap,
  collapsed,
  selectedTaskId,
  busy,
  onToggleBand,
  onSelectTask,
  onCancelTask,
}: {
  configs: ReadonlyArray<BandConfig>;
  bands: Record<BotTaskBand, BotTaskItem[]>;
  botNameMap: ReadonlyMap<string, string>;
  collapsed: Record<string, boolean>;
  selectedTaskId: string | null;
  busy: boolean;
  onToggleBand: (key: string) => void;
  onSelectTask: (task: BotTaskItem) => void;
  onCancelTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {configs.map(({ band, labelKey, dotClass }) =>
        bands[band].length > 0 ? (
          <CollapsibleBand
            key={band}
            title={t(labelKey)}
            count={bands[band].length}
            dotClass={dotClass}
            collapsed={Boolean(collapsed[band])}
            onToggle={() => onToggleBand(band)}
          >
            {bands[band].map((task) => (
              <BotTaskRow
                key={task.id}
                task={task}
                botName={botNameMap.get(task.targetBotId) ?? task.targetBotId}
                selected={selectedTaskId === task.id}
                busy={busy}
                onSelect={onSelectTask}
                onCancel={onCancelTask}
              />
            ))}
          </CollapsibleBand>
        ) : null,
      )}
    </>
  );
}

function CollaborationBandSection({
  groups,
  botNameMap,
  collapsed,
  selectedCollabId,
  selectedTaskId,
  busy,
  onToggle,
  onSelectCollaboration,
  onSelectTask,
  onCancelTask,
}: {
  groups: BotCollaborationGroup[];
  botNameMap: ReadonlyMap<string, string>;
  collapsed: boolean;
  selectedCollabId: string | null;
  selectedTaskId: string | null;
  busy: boolean;
  onToggle: () => void;
  onSelectCollaboration: (groupId: string) => void;
  onSelectTask: (task: BotTaskItem) => void;
  onCancelTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  if (groups.length === 0) return null;
  return (
    <CollapsibleBand
      title={t('botWork.bandCollaborations')}
      count={groups.length}
      dotClass={styles.bandDotCollab}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {groups.map((group) => (
        <BotCollaborationRow
          key={group.id}
          group={group}
          botNameMap={botNameMap}
          selectedCollabId={selectedCollabId}
          selectedTaskId={selectedTaskId}
          busy={busy}
          onSelectCollaboration={onSelectCollaboration}
          onSelectTask={onSelectTask}
          onCancelTask={onCancelTask}
        />
      ))}
    </CollapsibleBand>
  );
}

function hasAnyFilterCriteria(activeFilterCount: number, query: string): boolean {
  return activeFilterCount > 0 || Boolean(query.trim());
}

export function BotTaskListPane({
  bots,
  botNameMap,
  statuses,
  groups,
  bands,
  totalStandaloneCount,
  filteredStandaloneCount,
  cursor,
  busy,
  filters,
  facets,
  activeFilterCount,
  selectedTaskId,
  selectedCollabId,
  onFiltersChange,
  onClearFilters,
  onSelectTask,
  onSelectCollaboration,
  onCancelTask,
  onLoadOlder,
  onRefresh,
  onOpenDefaultBot,
}: BotTaskListPaneProps) {
  const { t } = useI18n();
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleBand = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const hasVisibleRows = groups.length + filteredStandaloneCount > 0;
  const hasAnyItems = groups.length + totalStandaloneCount > 0;

  return (
    <div className={styles.listPane}>
      <ListHeadBar
        bots={bots}
        filters={filters}
        facets={facets}
        activeFilterCount={activeFilterCount}
        filterOpen={filterOpen}
        onToggleFilter={() => setFilterOpen((open) => !open)}
        onCloseFilter={() => setFilterOpen(false)}
        onFiltersChange={onFiltersChange}
        onClearFilters={onClearFilters}
      />

      <div className={styles.listScroll}>
        <TaskBandSections
          configs={PRIORITY_BAND_CONFIG}
          bands={bands}
          botNameMap={botNameMap}
          collapsed={collapsed}
          selectedTaskId={selectedTaskId}
          busy={busy}
          onToggleBand={toggleBand}
          onSelectTask={onSelectTask}
          onCancelTask={onCancelTask}
        />

        <CollaborationBandSection
          groups={groups}
          botNameMap={botNameMap}
          collapsed={Boolean(collapsed.collaborations)}
          selectedCollabId={selectedCollabId}
          selectedTaskId={selectedTaskId}
          busy={busy}
          onToggle={() => toggleBand('collaborations')}
          onSelectCollaboration={onSelectCollaboration}
          onSelectTask={onSelectTask}
          onCancelTask={onCancelTask}
        />

        <TaskBandSections
          configs={HISTORY_BAND_CONFIG}
          bands={bands}
          botNameMap={botNameMap}
          collapsed={collapsed}
          selectedTaskId={selectedTaskId}
          busy={busy}
          onToggleBand={toggleBand}
          onSelectTask={onSelectTask}
          onCancelTask={onCancelTask}
        />

        {!hasVisibleRows && (
          <ListEmptyState
            hasAnyItems={hasAnyItems}
            hasActiveFilters={hasAnyFilterCriteria(activeFilterCount, filters.query)}
            busy={busy}
            onClearFilters={onClearFilters}
          />
        )}

        {cursor && (
          <button type="button" className={styles.olderBtn} disabled={busy} onClick={onLoadOlder}>
            {t('botWork.older')}
          </button>
        )}
      </div>

      <StatusRosterDrawer
        statuses={statuses}
        busy={busy}
        onRefresh={onRefresh}
        onOpenDefaultBot={onOpenDefaultBot}
      />
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { createBotDispatchIdentity } from '@/lib/bot-dispatch';
import {
  countBotTaskFacets,
  filterBotTasks,
  groupBotTasksByBand,
  stepItemId,
  type BotCollaborationGroup,
  type BotTaskDetail,
  type BotTaskFilterState,
  type BotTaskItem,
} from '@/lib/bot-tasks-view';
import { api, json, useAction, Feedback } from './shared';
import { ConnectionNotice } from './ConnectionNotice';
import { BotProductMetrics } from './BotProductMetrics';
import { BotTaskQuickComposer } from './BotTaskQuickComposer';
import { BotTaskListPane } from './BotTaskListPane';
import { BotTaskDetailPane } from './BotTaskDetailPane';
import { useBotTeamWorkData } from './useBotTeamWorkData';
import styles from './bot-team-work.module.css';

const DEFAULT_FILTERS: BotTaskFilterState = {
  query: '',
  botId: '',
  band: 'all',
  timeRange: 'all',
};

function countActiveFilters(filters: BotTaskFilterState): number {
  let count = 0;
  if (filters.botId) count += 1;
  if (filters.band !== 'all') count += 1;
  if (filters.timeRange !== 'all') count += 1;
  return count;
}

function matchesCollaborationQuery(
  group: BotCollaborationGroup,
  needle: string,
  botNameMap: ReadonlyMap<string, string>,
): boolean {
  if (!needle) return true;
  if (group.goal.toLowerCase().includes(needle)) return true;
  return group.members.some((member) => {
    const botName = (botNameMap.get(member.targetBotId) ?? member.targetBotId).toLowerCase();
    return member.input.toLowerCase().includes(needle) || botName.includes(needle);
  });
}

function pickInitialDesktopTask(
  orderedStandalone: readonly BotTaskItem[],
  groups: readonly BotCollaborationGroup[],
): { task: BotTaskItem | null; collabId: string | null } {
  if (orderedStandalone.length > 0) return { task: orderedStandalone[0], collabId: null };
  if (groups.length > 0) return { task: null, collabId: groups[0].id };
  return { task: null, collabId: null };
}

function shouldAutoSelect(
  didAutoSelect: boolean,
  selected: BotTaskDetail | null,
  selectedCollabId: string | null,
): boolean {
  return !didAutoSelect && !selected && !selectedCollabId;
}

function applyInitialSelection(
  orderedStandalone: readonly BotTaskItem[],
  groups: readonly BotCollaborationGroup[],
  onSelectTask: (task: BotTaskItem) => void,
  onSelectCollab: (id: string) => void,
): void {
  const initial = pickInitialDesktopTask(orderedStandalone, groups);
  if (initial.task) onSelectTask(initial.task);
  else if (initial.collabId) onSelectCollab(initial.collabId);
}

export function BotTeamWork({
  bots,
  onOpen,
}: {
  bots: BotInfo[];
  onOpen: (bot: BotInfo) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const action = useAction();
  const dispatchIdentity = useRef(createBotDispatchIdentity());
  const data = useBotTeamWorkData(action);

  const [target, setTarget] = useState('');
  const [input, setInput] = useState('');
  const [sourceDelivery, setSourceDelivery] = useState<{ taskId: string; attempt: number } | null>(null);
  const [filters, setFilters] = useState<BotTaskFilterState>(DEFAULT_FILTERS);

  const botNameMap = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const groupedIds = useMemo(
    () => new Set(data.groups.flatMap((group) => group.members.map((task) => task.id))),
    [data.groups],
  );
  const standaloneTasks = useMemo(
    () => data.tasks.filter((task) => !groupedIds.has(task.id)),
    [data.tasks, groupedIds],
  );
  const facets = useMemo(
    () => countBotTaskFacets(standaloneTasks, botNameMap),
    [standaloneTasks, botNameMap],
  );
  const filteredTasks = useMemo(
    () => filterBotTasks(standaloneTasks, filters, botNameMap),
    [standaloneTasks, filters, botNameMap],
  );
  const bands = useMemo(() => groupBotTasksByBand(filteredTasks), [filteredTasks]);
  const visibleGroups = useMemo(() => {
    const needle = filters.query.trim().toLowerCase();
    return data.groups.filter((group) => matchesCollaborationQuery(group, needle, botNameMap));
  }, [data.groups, filters.query, botNameMap]);

  const orderedStandalone = useMemo(
    () => [...bands.attention, ...bands.active, ...bands.history],
    [bands],
  );
  const orderedTaskIds = useMemo(
    () => [
      ...orderedStandalone.map((task) => task.id),
      ...visibleGroups.flatMap((group) => group.members.map((member) => member.id)),
    ],
    [orderedStandalone, visibleGroups],
  );
  const taskById = useMemo(
    () => new Map(data.tasks.map((task) => [task.id, task])),
    [data.tasks],
  );

  useEffect(() => {
    if (!shouldAutoSelect(data.didAutoSelectRef.current, data.selected, data.selectedCollabId)) return;
    applyInitialSelection(
      orderedStandalone,
      visibleGroups,
      data.autoSelectTask,
      data.selectCollaboration,
    );
  }, [orderedStandalone, visibleGroups, data]);

  const selectedCollab = useMemo(
    () => data.groups.find((group) => group.id === data.selectedCollabId) ?? null,
    [data.groups, data.selectedCollabId],
  );
  const prevTaskId = data.selected ? stepItemId(orderedTaskIds, data.selected.id, -1) : null;
  const nextTaskId = data.selected ? stepItemId(orderedTaskIds, data.selected.id, 1) : null;

  const handleDispatch = () => {
    void action.run(async () => {
      await api(
        '/api/bot-work/tasks',
        json({
          targetBotId: target,
          input,
          idempotencyKey: dispatchIdentity.current.forInput(target, input),
          ...(sourceDelivery ? { sourceDelivery } : {}),
        }),
      );
      dispatchIdentity.current.accepted();
      setInput('');
      setSourceDelivery(null);
      await data.load();
    });
  };

  const handleContinueFromDelivery = (task: BotTaskDetail) => {
    if (!task.delivery) return;
    setSourceDelivery({ taskId: task.id, attempt: task.delivery.attempt });
    setTarget(task.targetBotId);
    setInput('');
    dispatchIdentity.current.accepted();
    document.querySelector<HTMLTextAreaElement>('[data-testid="bot-team-work"] textarea')?.focus();
  };

  const handleOpenDefaultBot = () => {
    void action.run(async () => {
      const result = (await api('/api/bot-work/default')) as { bot: BotInfo };
      await onOpen(result.bot);
    });
  };

  const handleContinueInChat = (botId: string) => {
    const bot = bots.find((entry) => entry.id === botId);
    if (bot) void onOpen(bot);
  };

  const handleStepTask = (taskId: string) => {
    const targetTask = taskById.get(taskId);
    if (targetTask) data.selectTask(targetTask);
  };

  return (
    <section className={styles.shell} data-testid="bot-team-work">
      <div className={styles.topBar}>
        <div className={styles.headerRow}>
          <h3 className={styles.heading}>{t('botWork.team')}</h3>
          <p className={styles.lead} data-testid="bot-team-work-lead">
            {t('botWork.dispatchLead')}
          </p>
          <div className={styles.headerRight}>
            <BotProductMetrics />
          </div>
        </div>

        <div className={styles.statusStripInline}>
          <Feedback {...action} />
          <ConnectionNotice
            disconnected={data.disconnected}
            lastUpdatedAt={data.lastUpdatedAt}
            testId="bot-task-connection"
            className={styles.connectionBanner}
          />
        </div>

        <BotTaskQuickComposer
          bots={bots}
          target={target}
          input={input}
          busy={action.busy}
          sourceDelivery={sourceDelivery}
          onTargetChange={setTarget}
          onInputChange={setInput}
          onClearSource={() => {
            setSourceDelivery(null);
            dispatchIdentity.current.accepted();
          }}
          onSubmit={handleDispatch}
        />
      </div>

      <div className={styles.workspace}>
        <BotTaskListPane
          bots={bots}
          botNameMap={botNameMap}
          statuses={data.statuses}
          groups={visibleGroups}
          bands={bands}
          totalStandaloneCount={standaloneTasks.length}
          filteredStandaloneCount={filteredTasks.length}
          cursor={data.cursor}
          busy={action.busy}
          filters={filters}
          facets={facets}
          activeFilterCount={countActiveFilters(filters)}
          selectedTaskId={data.selected?.id ?? null}
          selectedCollabId={data.selectedCollabId}
          onFiltersChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
          onClearFilters={() => setFilters(DEFAULT_FILTERS)}
          onSelectTask={data.selectTask}
          onSelectCollaboration={data.selectCollaboration}
          onCancelTask={data.cancelTask}
          onLoadOlder={data.loadOlder}
          onRefresh={() => void action.run(data.load)}
          onOpenDefaultBot={handleOpenDefaultBot}
        />

        <BotTaskDetailPane
          selected={data.selected}
          selectedCollab={selectedCollab}
          routineTask={data.routineTask}
          botNameMap={botNameMap}
          busy={action.busy}
          confirmUnknown={data.confirmUnknown}
          prevTaskId={prevTaskId}
          nextTaskId={nextTaskId}
          onConfirmUnknownChange={data.setConfirmUnknown}
          onStepTask={handleStepTask}
          onCloseDetail={data.clearSelection}
          onContinueInChat={handleContinueInChat}
          onSaveAsRoutine={data.setRoutineTask}
          onCloseRoutine={() => data.setRoutineTask(null)}
          onOpenSourceVersion={(source) =>
            data.openSourceVersion(source, t('botWork.versionUnavailable'))
          }
          onSelectDeliveryAttempt={data.selectDeliveryAttempt}
          onContinueFromDelivery={handleContinueFromDelivery}
          onRetry={data.retrySelected}
          onCancel={data.cancelTask}
          onSelectMemberTask={data.selectTask}
        />
      </div>
    </section>
  );
}

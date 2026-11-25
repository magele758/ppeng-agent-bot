'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  findDroppedUnresolvedIds,
  mergePolledBotTasks,
  type BotCollaborationGroup,
  type BotTaskDetail,
  type BotTaskItem,
  type BotTaskStatusRow,
} from '@/lib/bot-tasks-view';
import { api, json } from './shared';

type ActionRunner = {
  busy: boolean;
  error: string;
  run: (fn: () => Promise<void>) => Promise<void>;
};

interface RawPagePayload {
  collaborations?: BotCollaborationGroup[];
  tasks?: BotTaskItem[];
  activeTasks?: BotTaskItem[];
  historyTasks?: BotTaskItem[];
  nextCursor?: string | null;
}

interface NormalizedPage {
  collaborations: BotCollaborationGroup[];
  tasks?: BotTaskItem[];
  activeTasks: BotTaskItem[];
  historyTasks: BotTaskItem[];
  nextCursor: string | null;
}

function normalizePage(raw: RawPagePayload): NormalizedPage {
  return {
    collaborations: raw.collaborations ?? [],
    tasks: raw.tasks,
    activeTasks: raw.activeTasks ?? [],
    historyTasks: raw.historyTasks ?? [],
    nextCursor: raw.nextCursor ?? null,
  };
}

async function fetchSnapshot(): Promise<{ bots: BotTaskStatusRow[]; page: NormalizedPage }> {
  const [statusRes, workRes] = (await Promise.all([
    api('/api/bot-work/status', { signal: AbortSignal.timeout(5000) }),
    api('/api/bot-work/tasks?limit=50', { signal: AbortSignal.timeout(5000) }),
  ])) as [{ bots: BotTaskStatusRow[] }, RawPagePayload];
  return { bots: statusRes.bots ?? [], page: normalizePage(workRes) };
}

async function fetchTaskDetailSilent(taskId: string): Promise<BotTaskDetail | null> {
  try {
    const data = (await api(`/api/bot-work/tasks/${encodeURIComponent(taskId)}`, {
      signal: AbortSignal.timeout(5000),
    })) as { task?: BotTaskDetail };
    return data.task ?? null;
  } catch {
    return null;
  }
}

async function resolveDroppedTasks(
  previous: readonly BotTaskItem[],
  page: NormalizedPage,
): Promise<BotTaskItem[]> {
  const droppedIds = findDroppedUnresolvedIds(previous, page);
  if (droppedIds.length === 0) return [];
  const resolved = await Promise.all(droppedIds.map((id) => fetchTaskDetailSilent(id)));
  return resolved.filter((item): item is BotTaskItem => item !== null);
}

function findChangedSummary(
  previous: BotTaskDetail | null,
  rows: readonly BotTaskItem[],
): BotTaskItem | null {
  if (!previous) return null;
  const summary = rows.find((task) => task.id === previous.id);
  return summary && summary.status !== previous.status ? summary : null;
}

export function useBotTeamWorkData(action: ActionRunner) {
  const [statuses, setStatuses] = useState<BotTaskStatusRow[]>([]);
  const [groups, setGroups] = useState<BotCollaborationGroup[]>([]);
  const [tasks, setTasks] = useState<BotTaskItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<BotTaskDetail | null>(null);
  const [selectedCollabId, setSelectedCollabId] = useState<string | null>(null);
  const [routineTask, setRoutineTask] = useState<BotTaskDetail | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);

  const tasksRef = useRef<BotTaskItem[]>(tasks);
  tasksRef.current = tasks;
  const selectedRef = useRef<BotTaskDetail | null>(selected);
  selectedRef.current = selected;
  const refreshGeneration = useRef(0);
  const didAutoSelectRef = useRef(false);

  const refreshSelectedIfChanged = useCallback(async (rows: readonly BotTaskItem[]) => {
    const previous = selectedRef.current;
    const changed = findChangedSummary(previous, rows);
    if (!previous || !changed) return;
    const fetched = await fetchTaskDetailSilent(previous.id);
    const next = fetched ?? { ...previous, ...changed };
    setSelected((current) => (current?.id === previous.id ? next : current));
  }, []);

  const load = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const { bots, page } = await fetchSnapshot();
      if (generation !== refreshGeneration.current) return;
      const nextTasks = page.tasks ?? [...page.activeTasks, ...page.historyTasks];
      setStatuses(bots);
      setGroups(page.collaborations);
      setTasks(nextTasks);
      setCursor(page.nextCursor);
      setPaged(false);
      await refreshSelectedIfChanged(nextTasks);
      setLastUpdatedAt(new Date().toISOString());
      setDisconnected(false);
    } catch (error) {
      if (generation === refreshGeneration.current) setDisconnected(true);
      throw error;
    }
  }, [refreshSelectedIfChanged]);

  const applyPolledSnapshot = useCallback(
    async (
      bots: BotTaskStatusRow[],
      page: NormalizedPage,
      isCurrent: () => boolean,
    ) => {
      setStatuses(bots);
      setGroups(page.collaborations);
      const finished = paged ? await resolveDroppedTasks(tasksRef.current, page) : [];
      const nextTasks = mergePolledBotTasks(page, tasksRef.current, paged, {
        extend: false,
        resolvedFinished: finished,
      });
      if (!isCurrent()) return;
      setTasks(nextTasks);
      await refreshSelectedIfChanged(nextTasks);
      if (!isCurrent()) return;
      setLastUpdatedAt(new Date().toISOString());
      setDisconnected(false);
      if (!paged) setCursor(page.nextCursor);
    },
    [paged, refreshSelectedIfChanged],
  );

  useEffect(() => {
    if (!paged) void action.run(load);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      const generation = ++refreshGeneration.current;
      const isCurrent = () => active && generation === refreshGeneration.current;
      void fetchSnapshot()
        .then(({ bots, page }) => (isCurrent() ? applyPolledSnapshot(bots, page, isCurrent) : undefined))
        .catch(() => {
          if (isCurrent()) setDisconnected(true);
        })
        .finally(() => {
          if (active) timer = setTimeout(poll, 3000);
        });
    };
    timer = setTimeout(poll, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [paged, action.run, load, applyPolledSnapshot]);

  const loadOlder = useCallback(() => {
    if (!cursor) return;
    void action.run(async () => {
      const raw = (await api(
        `/api/bot-work/tasks?limit=50&cursor=${encodeURIComponent(cursor)}`,
      )) as RawPagePayload;
      const page = normalizePage(raw);
      const finished = await resolveDroppedTasks(tasksRef.current, page);
      setTasks(
        mergePolledBotTasks(page, tasksRef.current, true, {
          extend: true,
          resolvedFinished: finished,
        }),
      );
      setCursor(page.nextCursor);
      setPaged(true);
    });
  }, [cursor, action]);

  const selectTask = useCallback(
    (task: BotTaskItem) => {
      didAutoSelectRef.current = true;
      setSelectedCollabId(null);
      setSelected(task);
      setConfirmUnknown(false);
      void action.run(async () => {
        const data = (await api(`/api/bot-work/tasks/${encodeURIComponent(task.id)}`)) as {
          task: BotTaskDetail;
        };
        setSelected(data.task);
      });
    },
    [action],
  );

  const autoSelectTask = useCallback((task: BotTaskItem) => {
    didAutoSelectRef.current = true;
    setSelectedCollabId(null);
    setSelected(task);
    void fetchTaskDetailSilent(task.id).then((fetched) => {
      if (fetched) setSelected((current) => (current?.id === task.id ? fetched : current));
    });
  }, []);

  const selectCollaboration = useCallback((groupId: string) => {
    didAutoSelectRef.current = true;
    setSelected(null);
    setSelectedCollabId(groupId);
    setConfirmUnknown(false);
  }, []);

  const clearSelection = useCallback(() => {
    didAutoSelectRef.current = true;
    setSelected(null);
    setSelectedCollabId(null);
    setRoutineTask(null);
  }, []);

  const cancelTask = useCallback(
    (taskId: string) => {
      void action.run(async () => {
        const res = (await api(`/api/bot-work/tasks/${encodeURIComponent(taskId)}/cancel`, {
          method: 'POST',
        })) as { task?: BotTaskDetail };
        if (res?.task) {
          setSelected((current) => (current?.id === taskId ? res.task! : current));
        }
        await load();
      });
    },
    [action, load],
  );

  const retrySelected = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    void action.run(async () => {
      const data = (await api(
        `/api/bot-work/tasks/${encodeURIComponent(current.id)}/retry`,
        json({ confirmUnknown }),
      )) as { task: BotTaskDetail };
      setSelected(data.task);
      setConfirmUnknown(false);
      await load();
    });
  }, [action, confirmUnknown, load]);

  const openSourceVersion = useCallback(
    (source: { taskId: string; attempt: number }, unavailableMsg: string) => {
      void action.run(async () => {
        const { task } = (await api(`/api/bot-work/tasks/${encodeURIComponent(source.taskId)}`)) as {
          task: BotTaskDetail;
        };
        const delivery = task.deliveryVersions?.find((v) => v.attempt === source.attempt);
        if (!delivery) throw new Error(unavailableMsg);
        setSelected({ ...task, delivery });
      });
    },
    [action],
  );

  const selectDeliveryAttempt = useCallback((attempt: number) => {
    setSelected((current) => {
      const delivery = current?.deliveryVersions?.find((v) => v.attempt === attempt);
      return current && delivery ? { ...current, delivery } : current;
    });
  }, []);

  return {
    statuses,
    groups,
    tasks,
    cursor,
    disconnected,
    lastUpdatedAt,
    selected,
    selectedCollabId,
    routineTask,
    confirmUnknown,
    didAutoSelectRef,
    setRoutineTask,
    setConfirmUnknown,
    load,
    loadOlder,
    selectTask,
    autoSelectTask,
    selectCollaboration,
    clearSelection,
    cancelTask,
    retrySelected,
    openSourceVersion,
    selectDeliveryAttempt,
  };
}

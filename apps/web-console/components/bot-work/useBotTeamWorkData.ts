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

function buildTaskDetailSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
}

async function fetchTaskDetail(taskId: string, signal?: AbortSignal): Promise<BotTaskDetail> {
  const data = (await api(`/api/bot-work/tasks/${encodeURIComponent(taskId)}`, {
    signal: buildTaskDetailSignal(signal),
  })) as { task: BotTaskDetail };
  return data.task;
}

async function fetchTaskDetailSilent(taskId: string, signal?: AbortSignal): Promise<BotTaskDetail | null> {
  try {
    return await fetchTaskDetail(taskId, signal);
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
): { previous: BotTaskDetail; changed: BotTaskItem } | null {
  if (!previous) return null;
  const summary = rows.find((task) => task.id === previous.id);
  return summary && summary.status !== previous.status ? { previous, changed: summary } : null;
}

export function useBotTeamWorkData(action: ActionRunner) {
  const runAction = action.run;
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
  const selectionReqRef = useRef(0);
  const selectionAbortRef = useRef<AbortController | null>(null);
  const didAutoSelectRef = useRef(false);

  useEffect(() => () => selectionAbortRef.current?.abort(), []);

  const startSelectionRequest = useCallback(() => {
    selectionAbortRef.current?.abort();
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    const reqId = ++selectionReqRef.current;
    return { reqId, signal: controller.signal };
  }, []);

  const cancelSelectionRequest = useCallback(() => {
    selectionAbortRef.current?.abort();
    selectionAbortRef.current = null;
    selectionReqRef.current += 1;
  }, []);

  const refreshSelectedIfChanged = useCallback(async (rows: readonly BotTaskItem[]) => {
    const match = findChangedSummary(selectedRef.current, rows);
    if (!match) return;
    const reqAtStart = selectionReqRef.current;
    const fetched = await fetchTaskDetailSilent(match.previous.id);
    if (reqAtStart !== selectionReqRef.current) return;
    const next = fetched ?? { ...match.previous, ...match.changed };
    setSelected((current) => (current?.id === match.previous.id ? next : current));
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
    if (!paged) void runAction(load);
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
  }, [paged, runAction, load, applyPolledSnapshot]);

  const loadOlder = useCallback(() => {
    if (!cursor) return;
    void runAction(async () => {
      const generation = ++refreshGeneration.current;
      const raw = (await api(
        `/api/bot-work/tasks?limit=50&cursor=${encodeURIComponent(cursor)}`,
      )) as RawPagePayload;
      if (generation !== refreshGeneration.current) return;
      const page = normalizePage(raw);
      const finished = await resolveDroppedTasks(tasksRef.current, page);
      if (generation !== refreshGeneration.current) return;
      setTasks(
        mergePolledBotTasks(page, tasksRef.current, true, {
          extend: true,
          resolvedFinished: finished,
        }),
      );
      setCursor(page.nextCursor);
      setPaged(true);
    });
  }, [cursor, runAction]);

  const selectTask = useCallback(
    (task: BotTaskItem) => {
      didAutoSelectRef.current = true;
      const { reqId, signal } = startSelectionRequest();
      setSelectedCollabId(null);
      setRoutineTask(null);
      setConfirmUnknown(false);
      setSelected(task);
      void fetchTaskDetailSilent(task.id, signal).then((fetched) => {
        if (reqId === selectionReqRef.current && fetched) setSelected(fetched);
      });
    },
    [startSelectionRequest],
  );

  const autoSelectTask = useCallback(
    (task: BotTaskItem) => {
      didAutoSelectRef.current = true;
      const { reqId, signal } = startSelectionRequest();
      setSelectedCollabId(null);
      setRoutineTask(null);
      setSelected(task);
      void fetchTaskDetailSilent(task.id, signal).then((fetched) => {
        if (reqId === selectionReqRef.current && fetched) setSelected(fetched);
      });
    },
    [startSelectionRequest],
  );

  const selectCollaboration = useCallback(
    (groupId: string) => {
      didAutoSelectRef.current = true;
      cancelSelectionRequest();
      setSelected(null);
      setRoutineTask(null);
      setSelectedCollabId(groupId);
      setConfirmUnknown(false);
    },
    [cancelSelectionRequest],
  );

  const clearSelection = useCallback(() => {
    didAutoSelectRef.current = true;
    cancelSelectionRequest();
    setSelected(null);
    setSelectedCollabId(null);
    setRoutineTask(null);
  }, [cancelSelectionRequest]);

  const cancelTask = useCallback(
    (taskId: string) => {
      void runAction(async () => {
        const res = (await api(`/api/bot-work/tasks/${encodeURIComponent(taskId)}/cancel`, {
          method: 'POST',
        })) as { task?: BotTaskDetail };
        if (res?.task) {
          setSelected((current) => (current?.id === taskId ? res.task! : current));
        }
        await load();
      });
    },
    [runAction, load],
  );

  const retrySelected = useCallback(() => {
    const current = selectedRef.current;
    if (!current) return;
    const { reqId } = startSelectionRequest();
    void runAction(async () => {
      const data = (await api(
        `/api/bot-work/tasks/${encodeURIComponent(current.id)}/retry`,
        json({ confirmUnknown }),
      )) as { task: BotTaskDetail };
      if (reqId === selectionReqRef.current) {
        setSelected(data.task);
        setConfirmUnknown(false);
      }
      await load();
    });
  }, [runAction, confirmUnknown, load, startSelectionRequest]);

  const openSourceVersion = useCallback(
    (source: { taskId: string; attempt: number }, unavailableMsg: string) => {
      const { reqId, signal } = startSelectionRequest();
      void runAction(async () => {
        const task = await fetchTaskDetail(source.taskId, signal);
        const delivery = task.deliveryVersions?.find((v) => v.attempt === source.attempt);
        if (!delivery) throw new Error(unavailableMsg);
        if (reqId === selectionReqRef.current) {
          setSelectedCollabId(null);
          setRoutineTask(null);
          setSelected({ ...task, delivery });
        }
      });
    },
    [runAction, startSelectionRequest],
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

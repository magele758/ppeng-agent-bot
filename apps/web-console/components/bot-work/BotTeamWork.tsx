"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { BotInfo } from "@/lib/types";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
import { ConnectionNotice } from "./ConnectionNotice";
import { createBotDispatchIdentity } from "@/lib/bot-dispatch";
import { TaskDelivery, type Delivery } from "./TaskDelivery";
import { botConnectionsHref } from "@/lib/bot-recovery-link";
import { BotCronPanel } from "../BotCronPanel";
import { BotProductMetrics } from "./BotProductMetrics";
type Task = {
  id: string;
  targetBotId: string;
  input: string;
  status: string;
  result?: unknown;
  failureReason?: string;
  delivery?: Delivery;
  deliveryVersions?: Delivery[];
  sourceDelivery?: { taskId: string; attempt: number };
};
type Collaboration = { id:string;goal:string;status:string;completed:number;total:number;members:Task[];blockers:Task[];deliveries:Task[] };
type Status = { bot: BotInfo; status: string; pending: number };
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
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [groups,setGroups]=useState<Collaboration[]>([]);
  const [routineTask,setRoutineTask]=useState<Task|null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const [cursor, setCursor] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const unresolved = (task: Task) => ["queued", "running", "waiting_approval", "unknown"].includes(task.status);
  type Page = { collaborations?:Collaboration[]; tasks: Task[]; activeTasks: Task[]; historyTasks: Task[]; nextCursor?: string };
  const mergeRetainedHistory = async (page: Page, extend: boolean): Promise<Task[]> => {
    const previous = tasksRef.current;
    const activeIds = new Set(page.activeTasks.map(task => task.id));
    const incomingHistory = new Map(page.historyTasks.map(task => [task.id, task]));
    // A completed known task may already be outside the newest history page.
    const finished = await Promise.all(previous.filter(task => unresolved(task) && !activeIds.has(task.id)).map(async task => {
      const current = incomingHistory.get(task.id);
      if (current) return current;
      return (await api(`/api/bot-work/tasks/${task.id}`) as { task: Task }).task;
    }));
    const retained = previous.filter(task => !unresolved(task) && !activeIds.has(task.id));
    const previousIds = new Set(previous.map(task => task.id));
    const history = page.historyTasks.filter(task => extend || previousIds.has(task.id));
    return Array.from(new Map([...retained, ...history, ...finished, ...page.activeTasks].map(task => [task.id, task])).values());
  };
  const [target, setTarget] = useState("");
  const [input, setInput] = useState("");
  const [sourceDelivery, setSourceDelivery] = useState<{ taskId: string; attempt: number } | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const updateSelected = async (rows: Task[]) => {
    const previous = selectedRef.current;
    if (!previous) return;
    const summary = rows.find(task => task.id === previous.id);
    if (!summary || summary.status === previous.status) return;
    const data = await api(`/api/bot-work/tasks/${encodeURIComponent(previous.id)}`, {
      signal: AbortSignal.timeout(5000),
    }) as { task: Task };
    setSelected(current => current?.id === previous.id ? data.task : current);
  };
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const load = async () => {
    const generation = ++refreshGeneration.current;
    try {
    const [status, work] = (await Promise.all([
      api("/api/bot-work/status", { signal: AbortSignal.timeout(5000) }),
      api("/api/bot-work/tasks?limit=50", { signal: AbortSignal.timeout(5000) }),
    ])) as [{ bots: Status[] }, Page];
    if (generation !== refreshGeneration.current) return;
    setStatuses(status.bots);
    setTasks(work.tasks);setGroups(work.collaborations??[]);
    setCursor(work.nextCursor ?? null);setPaged(false);
    await updateSelected(work.tasks);
    setLastUpdatedAt(new Date().toISOString());setDisconnected(false);
    } catch (error) {
      if (generation === refreshGeneration.current) setDisconnected(true);
      throw error;
    }
  };
  useEffect(() => {
    if (!paged) void action.run(load);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      const generation = ++refreshGeneration.current;
      void Promise.all([
        api("/api/bot-work/status", { signal: AbortSignal.timeout(5000) }),
        api("/api/bot-work/tasks?limit=50", { signal: AbortSignal.timeout(5000) }),
      ])
        .then(async ([status, work]) => {
          if (!active || generation !== refreshGeneration.current) return;
          setStatuses((status as { bots: Status[] }).bots);
          const page = work as Page;
          setGroups(page.collaborations??[]);
          const next = paged ? await mergeRetainedHistory(page, false) : page.tasks;
          if (!active || generation !== refreshGeneration.current) return;
          setTasks(next);
          await updateSelected(next);
          if (!active || generation !== refreshGeneration.current) return;
          setLastUpdatedAt(new Date().toISOString());setDisconnected(false);
          if (!paged) setCursor(page.nextCursor ?? null);
        })
        .catch(() => { if (active && generation === refreshGeneration.current) setDisconnected(true); })
        .finally(() => { if (active) timer = setTimeout(poll, 3000); });
    };
    timer = setTimeout(poll, 3000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [paged]);
  const groupedIds=new Set(groups.flatMap(group=>group.members.map(task=>task.id)));
  const unresolvedTasks = tasks.filter((task) => unresolved(task)&&!groupedIds.has(task.id));
  const historyTasks = tasks.filter((task) => !unresolved(task)&&!groupedIds.has(task.id));
  const taskArticle = (task: Task) => (
        <article key={task.id}>
          <p>
            {bots.find((b) => b.id === task.targetBotId)?.name ??
              task.targetBotId}
            : {task.input}
          </p>
          <p>
            <Status value={task.status} />
          </p>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const data = (await api(`/api/bot-work/tasks/${task.id}`)) as {
                  task: Task;
                };
                setSelected(data.task);setConfirmUnknown(false);
              })
            }
          >
            {t("botWork.details")}
          </button>
          {["queued", "running", "waiting_approval"].includes(task.status) && (
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/bot-work/tasks/${task.id}/cancel`, {
                    method: "POST",
                  });
                  await load();
                })
              }
            >
              {t("botWork.cancel")}
            </button>
          )}
        </article>
      );
  return (
    <section className="ag-panel" data-testid="bot-team-work">
      <h3>{t("botWork.team")}</h3>
      <BotProductMetrics />
      <p className="bot-work-dispatch-lead" data-testid="bot-team-work-lead">
        {t("botWork.dispatchLead")}
      </p>
      <Feedback {...action} />
      <ConnectionNotice disconnected={disconnected} lastUpdatedAt={lastUpdatedAt} testId="bot-task-connection" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              "/api/bot-work/tasks",
              json({
                targetBotId: target,
                input,
                idempotencyKey: dispatchIdentity.current.forInput(target, input),
                ...(sourceDelivery ? { sourceDelivery } : {}),
              }),
            );
            dispatchIdentity.current.accepted();
            setInput("");
            setSourceDelivery(null);
            await load();
          });
        }}
      >
        {sourceDelivery && <p role="status">
          {t("botWork.usingVersion", { task: sourceDelivery.taskId, attempt: sourceDelivery.attempt })}
          <button type="button" onClick={() => {setSourceDelivery(null);dispatchIdentity.current.accepted();}}>{t("botWork.clearVersion")}</button>
        </p>}
        <label>
          {t("botWork.target")}
          <select
            required
            aria-label={t("botWork.target")}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{t("botWork.notSelected")}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("botWork.prompt")}
          <textarea
            required
            aria-label={t("botWork.prompt")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button disabled={action.busy}>{t("botWork.assign")}</button>
      </form>
      {groups.map(group=><article key={group.id} data-testid="collaboration-summary">
        <h4>{group.goal}</h4>
        <p>{t('botWork.collaborationProgress',{completed:group.completed,total:group.total})} · {group.status==='blocked'?t('botWork.collaborationBlocked'):<Status value={group.status}/>}</p>
        {group.blockers.map(task=><p key={task.id}>{bots.find(bot=>bot.id===task.targetBotId)?.name??task.targetBotId}: {task.input} · <Status value={task.status}/> · {task.failureReason}</p>)}
        <h5>{t('botWork.collaborationDelivery')}</h5>
        {group.deliveries.map(task=><div key={task.id}><strong>{task.input}</strong><Result value={task.delivery?.report??task.result??task.failureReason}/></div>)}
        <details><summary>{t('botWork.collaborationMembers')}</summary>{group.members.map(taskArticle)}</details>
      </article>)}
      <h4>{t("botWork.unresolved")}</h4>
      {unresolvedTasks.length ? unresolvedTasks.map(taskArticle) : !action.busy ? <p>{t("botWork.empty")}</p> : null}
      <h4>{t("botWork.taskHistory")}</h4>
      {historyTasks.length ? historyTasks.map(taskArticle) : <p>{t("botWork.empty")}</p>}
      {cursor && <button disabled={action.busy} onClick={() => void action.run(async () => {
        const page = await api(`/api/bot-work/tasks?limit=50&cursor=${encodeURIComponent(cursor)}`) as Page;
        setTasks(await mergeRetainedHistory(page, true));
        setCursor(page.nextCursor ?? null);setPaged(true);
      })}>{t("botWork.older")}</button>}
      <details className="bot-work-more">
        <summary data-testid="bot-work-history-toggle">{t("botWork.more")}</summary>
        <button disabled={action.busy} onClick={() => void action.run(load)}>
          {t("botWork.refresh")}
        </button>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const result = (await api("/api/bot-work/default")) as {
                bot: BotInfo;
              };
              await onOpen(result.bot);
            })
          }
        >
          {t("botWork.defaultBot")}
        </button>
        <h4>{t("botWork.roster")}</h4>
        <ul>
          {statuses.map((s) => (
            <li role="presentation" key={s.bot.id}>
              {s.bot.name} · <Status value={s.status} /> · {s.pending}
            </li>
          ))}
        </ul>
      </details>
      {routineTask&&<BotCronPanel key={routineTask.id} botId={routineTask.targetBotId} taskTemplate={{taskId:routineTask.id,attempt:routineTask.delivery!.attempt,prompt:routineTask.input}}/>}
      {selected && (
        <aside>
          <h4>{t("botWork.result")}</h4>
          <p>
            <Status value={selected.status} />
          </p>
          <a href={botConnectionsHref(selected.targetBotId)}>{t("botWork.repairConnection")}</a>
          <button type="button" onClick={() => {
            const bot = bots.find(bot => bot.id === selected.targetBotId);
            if (bot) void onOpen(bot);
          }}>{t("botWork.continueInChat")}</button>
          {selected.status==='completed'&&selected.delivery?.executionStatus==='completed'&&<button type="button" onClick={()=>setRoutineTask(selected)}>{t('botWork.saveAsRoutine')}</button>}
          {selected.status === "cancelled" && <p>{t("botWork.cancelEffectNote")}</p>}
          {selected.sourceDelivery && <button type="button" disabled={action.busy} onClick={() => {
            const source = selected.sourceDelivery!;
            void action.run(async () => {
              const { task } = await api(`/api/bot-work/tasks/${encodeURIComponent(source.taskId)}`) as { task: Task };
              const delivery = task.deliveryVersions?.find(version => version.attempt === source.attempt);
              if (!delivery) throw new Error(t("botWork.versionUnavailable"));
              setSelected({ ...task, delivery });
            });
          }}>{t("botWork.viewSourceVersion")}</button>}
          {(selected.deliveryVersions?.length ?? 0) > 1 && <label>
            {t("botWork.deliveryVersion")}
            <select aria-label={t("botWork.deliveryVersion")} value={selected.delivery?.attempt ?? ''} onChange={event => {
              const delivery = selected.deliveryVersions?.find(version => version.attempt === Number(event.target.value));
              if(delivery)setSelected({ ...selected, delivery });
            }}>
              {selected.deliveryVersions?.map(version => <option key={version.attempt} value={version.attempt}>{t("botWork.deliveryAttempt", { attempt: version.attempt })}</option>)}
            </select>
          </label>}
          {selected.delivery
            ? <TaskDelivery key={`${selected.id}:${selected.delivery.attempt}`} delivery={selected.delivery} onContinue={() => {
                setSourceDelivery({ taskId: selected.id, attempt: selected.delivery!.attempt });
                setTarget(selected.targetBotId);setInput("");dispatchIdentity.current.accepted();
                document.querySelector<HTMLTextAreaElement>('[data-testid="bot-team-work"] textarea')?.focus();
              }} />
            : <Result value={selected.result ?? selected.failureReason ?? selected} />}
          {selected.status === "unknown" && (
            <label>
              <input
                type="checkbox"
                checked={confirmUnknown}
                onChange={(e) => setConfirmUnknown(e.target.checked)}
              />
              {t("botWork.confirmUnknown")}
            </label>
          )}
          {["failed", "cancelled", "unknown"].includes(selected.status) && (
            <button
              disabled={
                action.busy ||
                (selected.status === "unknown" && !confirmUnknown)
              }
              onClick={() =>
                void action.run(async () => {
                  const data = (await api(
                    `/api/bot-work/tasks/${selected.id}/retry`,
                    json({ confirmUnknown }),
                  )) as { task: Task };
                  setSelected(data.task);setConfirmUnknown(false);
                  setConfirmUnknown(false);
                  await load();
                })
              }
            >
              {t("botWork.retry")}
            </button>
          )}
        </aside>
      )}
    </section>
  );
}

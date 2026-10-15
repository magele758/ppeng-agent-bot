"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { BotInfo } from "@/lib/types";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
type Task = {
  id: string;
  targetBotId: string;
  input: string;
  status: string;
  result?: unknown;
  failureReason?: string;
};
type Status = { bot: BotInfo; status: string; pending: number };
export function BotTeamWork({
  bots,
  onOpen,
}: {
  bots: BotInfo[];
  onOpen: (bot: BotInfo) => void;
}) {
  const { t } = useI18n();
  const action = useAction();
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const [cursor, setCursor] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const unresolved = (task: Task) => ["queued", "running", "waiting_approval", "unknown"].includes(task.status);
  type Page = { tasks: Task[]; activeTasks: Task[]; historyTasks: Task[]; nextCursor?: string };
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
  const [selected, setSelected] = useState<Task | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const load = async () => {
    const [status, work] = (await Promise.all([
      api("/api/bot-work/status"),
      api("/api/bot-work/tasks?limit=50"),
    ])) as [{ bots: Status[] }, Page];
    setStatuses(status.bots);
    setTasks(work.tasks);
    setCursor(work.nextCursor ?? null);setPaged(false);
  };
  useEffect(() => {
    if (!paged) void action.run(load);
    let active = true;
    const timer = setInterval(() => {
      void Promise.all([
        api("/api/bot-work/status"),
        api("/api/bot-work/tasks?limit=50"),
      ])
        .then(async ([status, work]) => {
          if (!active) return;
          setStatuses((status as { bots: Status[] }).bots);
          const page = work as Page;
          const next = paged ? await mergeRetainedHistory(page, false) : page.tasks;
          if (!active) return;
          setTasks(next);
          if (!paged) setCursor(page.nextCursor ?? null);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [paged]);
  const unresolvedTasks = tasks.filter((task) => unresolved(task));
  const historyTasks = tasks.filter((task) => !unresolved(task));
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
      <p className="bot-work-dispatch-lead" data-testid="bot-team-work-lead">
        {t("botWork.dispatchLead")}
      </p>
      <Feedback {...action} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              "/api/bot-work/tasks",
              json({
                targetBotId: target,
                input,
                idempotencyKey: crypto.randomUUID(),
              }),
            );
            setInput("");
            await load();
          });
        }}
      >
        <label>
          {t("botWork.target")}
          <select
            required
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button disabled={action.busy}>{t("botWork.assign")}</button>
      </form>
      <h4>{t("botWork.unresolved")}</h4>
      {unresolvedTasks.length ? unresolvedTasks.map(taskArticle) : !action.busy ? <p>{t("botWork.empty")}</p> : null}
      <details className="bot-work-more">
        <summary>{t("botWork.more")}</summary>
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
              onOpen(result.bot);
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
        <h4>{t("botWork.taskHistory")}</h4>
        {historyTasks.length ? historyTasks.map(taskArticle) : <p>{t("botWork.empty")}</p>}
        {cursor && <button disabled={action.busy} onClick={() => void action.run(async () => {
          const page = await api(`/api/bot-work/tasks?limit=50&cursor=${encodeURIComponent(cursor)}`) as Page;
          setTasks(await mergeRetainedHistory(page, true));
          setCursor(page.nextCursor ?? null);setPaged(true);
        })}>{t("botWork.older")}</button>}
      </details>
      {selected && (
        <aside>
          <h4>{t("botWork.result")}</h4>
          <p>
            <Status value={selected.status} />
          </p>
          <Result
            value={selected.result ?? selected.failureReason ?? selected}
          />
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

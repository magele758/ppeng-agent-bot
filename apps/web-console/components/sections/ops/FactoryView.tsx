"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n, type MessageKey } from "@/lib/i18n";

type Log = { id: string; path: string };
type Machine = {
  id: string;
  name: string;
  sshAlias: string;
  capacity: number;
  botIds: string[];
  allowedUserIds: string[];
  repositories: { id: string; path: string; logs?: Log[] }[];
  online?: boolean;
  occupied?: number;
  identity?: string;
};
type Settings = {
  owner: { userId: string };
  machines: Machine[];
  roomId: string;
  coordinatorBotId: string;
  patrol: { enabled: boolean; timezone: string };
};
type Task = {
  id: string;
  machineId: string;
  status: string;
  updatedAt: string;
  identity?: string;
  startedAt?: string;
  finishedAt?: string;
  history: { status: string; at: string }[];
  result?: unknown;
  error?: string;
};
const request = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const STATES = new Set([
  "queued",
  "running",
  "unknown",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);
function useFactoryController() {
  const { t } = useI18n();
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const [persistedRoomId, setPersistedRoomId] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null),
    [board, setBoard] = useState<{ machines: Machine[]; tasks: Task[] }>({
      machines: [],
      tasks: [],
    });
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]),
    [rooms, setRooms] = useState<{ id: string; title: string }[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [saved, setSaved] = useState(false),
    [connection, setConnection] = useState(""),
    [patrolAt, setPatrolAt] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const version = ++refreshVersion.current;
    const response = (await Promise.all([
      api("/api/factory/board"),
      api("/api/factory/patrol"),
    ]).catch(error => {
      if (mounted.current && version === refreshVersion.current) throw error;
      return undefined;
    })) as [
      { machines: Machine[]; tasks: Task[] },
      { settings: Settings["patrol"]; state: { lastRunAt?: string } },
    ] | undefined;
    if (!response) return;
    const [b, p] = response;
    // Periodic polls may overlap a user refresh. Only the newest response owns the view.
    if (!mounted.current || version !== refreshVersion.current) return;
    setBoard(b);
    setPatrolAt(p.state.lastRunAt ?? "");
    setSettings(old => old ? { ...old, patrol: p.settings } : old);
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void run(async () => {
      const [s, b, r] = (await Promise.all([
        api("/api/factory/settings"),
        api("/api/bots"),
        api("/api/bot-rooms"),
      ])) as [
          { settings: Settings },
          { bots: { id: string; name: string }[] },
          { rooms: { id: string; title: string }[] },
        ];
      if (!active) return;
      setSettings(s.settings);
      setPersistedRoomId(s.settings.roomId);
      setBots(b.bots);
      setRooms(r.rooms);
      await refresh();
    });
    const timer = setInterval(() => {
      if (active && document.visibilityState === "visible")
        void refresh().catch(() => { if (mounted.current) setError(true); });
    }, 5000);
    return () => {
      active = false;
      mounted.current = false;
      ++refreshVersion.current;
      clearInterval(timer);
    };
  }, []);
  const patch = (index: number, next: Partial<Machine>) =>
    setSettings((old) =>
      old
        ? {
          ...old,
          machines: old.machines.map((m, i) =>
            i === index ? { ...m, ...next } : m,
          ),
        }
        : old,
    );
  const status = (value: string) =>
    STATES.has(value)
      ? t(`factory.${value}` as MessageKey)
      : t("factory.unknown");
  return { t, settings, setSettings, board, bots, rooms, busy, error, saved, setSaved, connection, setConnection, patrolAt, persistedRoomId, setPersistedRoomId, run, refresh, patch, status };
}
type FactoryController = ReturnType<typeof useFactoryController>;

export function FactoryView() {
  const controller = useFactoryController();
  const { t, settings } = controller;
  return (
    <section className="ag-panel factory-panel" data-testid="factory-panel">
      <h3>{t("factory.title")}</h3>
      <p>{t("factory.hint")}</p>
      <p className="muted">{t("factory.scope")}</p>
      <FactoryFeedback controller={controller} />
      {!settings ? <p>{t("factory.loading")}</p> : <>
        <FactoryConfiguration controller={controller} />
        <FactoryMachines controller={controller} />
        <FactoryTasks controller={controller} />
        <FactoryPatrol controller={controller} />
        <FactoryCommands controller={controller} />
      </>}
    </section>
  );
}

function FactoryFeedback({ controller }: { controller: FactoryController }) {
  const { t, error, saved, connection } = controller;
  return (<>
    {error && <p role="alert">{t("factory.error")}</p>}
    {saved && <p role="status">{t("factory.saved")}</p>}
    {connection && <p role="status">{connection}</p>}
  </>);
}

function FactoryConfiguration({ controller }: { controller: FactoryController }) {
  const { t, settings: draft, setSettings, bots, rooms, busy, setSaved, setPersistedRoomId, run, refresh, patch } = controller;
  const settings = draft!;
  return (<>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        void run(async () => {
          const result = (await api(
            "/api/factory/settings",
            request(settings, "PATCH"),
          )) as { settings: Settings };
          setSettings(result.settings);
          setPersistedRoomId(result.settings.roomId);
          await refresh();
          setSaved(true);
        });
      }}
    >
      <fieldset disabled={busy}>
        <legend>{t("factory.machines")}</legend>
        <label>
          {t("factory.room")}
          <select
            data-testid="factory-room"
            required
            value={settings.roomId}
            onChange={(e) =>
              setSettings({ ...settings, roomId: e.target.value })
            }
          >
            <option value="">{t("factory.choose")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("factory.coordinator")}
          <select
            data-testid="factory-coordinator"
            required
            value={settings.coordinatorBotId}
            onChange={(e) =>
              setSettings({
                ...settings,
                coordinatorBotId: e.target.value,
              })
            }
          >
            <option value="">{t("factory.choose")}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        {settings.machines.map((m, index) => (
          <fieldset key={index}>
            <legend>{m.name || t("factory.machine")}</legend>
            <div className="factory-fields">
              <label>
                {t("factory.id")}
                <input
                  data-testid="factory-machine-id"
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                  value={m.id}
                  onChange={(e) => patch(index, { id: e.target.value })}
                />
              </label>
              <label>
                {t("factory.name")}
                <input
                  data-testid="factory-machine-name"
                  required
                  value={m.name}
                  onChange={(e) => patch(index, { name: e.target.value })}
                />
              </label>
              <label>
                {t("factory.alias")}
                <input
                  data-testid="factory-machine-alias"
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                  value={m.sshAlias}
                  onChange={(e) =>
                    patch(index, { sshAlias: e.target.value })
                  }
                />
              </label>
              <label>
                {t("factory.capacity")}
                <input
                  data-testid="factory-machine-capacity"
                  type="number"
                  min={0}
                  max={20}
                  required
                  value={m.capacity}
                  onChange={(e) =>
                    patch(index, { capacity: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                {t("factory.users")}
                <input
                  data-testid="factory-machine-users"
                  value={m.allowedUserIds.join(",")}
                  onChange={(e) =>
                    patch(index, {
                      allowedUserIds: e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                {t("factory.bots")}
                <select
                  data-testid="factory-machine-bots"
                  multiple
                  value={m.botIds}
                  onChange={(e) =>
                    patch(index, {
                      botIds: [...e.target.selectedOptions].map(
                        (o) => o.value,
                      ),
                    })
                  }
                >
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {m.repositories.map((repo, ri) => (
              <fieldset key={ri}>
                <legend>{t("factory.repositories")}</legend>
                <label>
                  {t("factory.repoId")}
                  <input
                    required
                    value={repo.id}
                    onChange={(e) =>
                      patch(index, {
                        repositories: m.repositories.map((r, j) =>
                          j === ri ? { ...r, id: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {t("factory.repoPath")}
                  <input
                    required
                    value={repo.path}
                    onChange={(e) =>
                      patch(index, {
                        repositories: m.repositories.map((r, j) =>
                          j === ri ? { ...r, path: e.target.value } : r,
                        ),
                      })
                    }
                  />
                </label>
                {(repo.logs ?? []).map((log, li) => (
                  <div key={li}>
                    <label>
                      {t("factory.logId")}
                      <input
                        required
                        value={log.id}
                        onChange={(e) =>
                          patch(index, {
                            repositories: m.repositories.map((r, j) =>
                              j === ri
                                ? {
                                  ...r,
                                  logs: r.logs?.map((l, k) =>
                                    k === li
                                      ? { ...l, id: e.target.value }
                                      : l,
                                  ),
                                }
                                : r,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      {t("factory.logPath")}
                      <input
                        required
                        value={log.path}
                        onChange={(e) =>
                          patch(index, {
                            repositories: m.repositories.map((r, j) =>
                              j === ri
                                ? {
                                  ...r,
                                  logs: r.logs?.map((l, k) =>
                                    k === li
                                      ? { ...l, path: e.target.value }
                                      : l,
                                  ),
                                }
                                : r,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    patch(index, {
                      repositories: m.repositories.map((r, j) =>
                        j === ri
                          ? {
                            ...r,
                            logs: [
                              ...(r.logs ?? []),
                              { id: "", path: "" },
                            ],
                          }
                          : r,
                      ),
                    })
                  }
                >
                  {t("factory.addLog")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    patch(index, {
                      repositories: m.repositories.filter(
                        (_, j) => j !== ri,
                      ),
                    })
                  }
                >
                  {t("factory.remove")}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() =>
                patch(index, {
                  repositories: [...m.repositories, { id: "", path: "" }],
                })
              }
            >
              {t("factory.addRepo")}
            </button>
            <button
              type="button"
              onClick={() =>
                setSettings({
                  ...settings,
                  machines: settings.machines.filter(
                    (_, i) => i !== index,
                  ),
                })
              }
            >
              {t("factory.remove")}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          data-testid="factory-add-machine"
          onClick={() =>
            setSettings({
              ...settings,
              machines: [
                ...settings.machines,
                {
                  id: "",
                  name: "",
                  sshAlias: "",
                  capacity: 2,
                  botIds: [],
                  allowedUserIds: [settings.owner.userId],
                  repositories: [],
                },
              ],
            })
          }
        >
          {t("factory.addMachine")}
        </button>
        <button data-testid="factory-save">{t("factory.save")}</button>
      </fieldset>
    </form>
  </>);
}

function FactoryMachines({ controller }: { controller: FactoryController }) {
  const { t, board, busy, run, refresh, setConnection } = controller;
  return (<>
    <button
      data-testid="factory-refresh"
      disabled={busy}
      onClick={() => void run(refresh)}
    >
      {t("factory.refresh")}
    </button>
    <div className="factory-table">
      <table>
        <thead>
          <tr>
            <th>{t("factory.machine")}</th>
            <th>{t("factory.state")}</th>
            <th>{t("factory.occupied")}</th>
            <th>{t("factory.probe")}</th>
          </tr>
        </thead>
        <tbody>
          {board.machines.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>
                {t(
                  m.online === undefined
                    ? "factory.unchecked"
                    : m.online
                      ? "factory.online"
                      : "factory.offline",
                )}
              </td>
              <td>
                {m.occupied ?? 0} / {m.capacity}
              </td>
              <td>
                <button
                  disabled={busy}
                  data-testid={`factory-probe-${m.id}`}
                  onClick={() =>
                    void run(async () => {
                      const result = (await api(
                        `/api/factory/machines/${encodeURIComponent(m.id)}/probe`,
                        request({}),
                      )) as { online: boolean; identity?: string };
                      setConnection(
                        result.online
                          ? t("factory.reachable", {
                            identity: result.identity ?? "",
                          })
                          : t("factory.unreachable"),
                      );
                      await refresh();
                    })
                  }
                >
                  {t("factory.probe")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

  </>);
}

function FactoryTasks({ controller }: { controller: FactoryController }) {
  const { t, board, busy, run, refresh, status } = controller;
  return (<>
    <h4>{t("factory.tasks")}</h4>
    {!board.tasks.length ? (
      <p>{t("factory.empty")}</p>
    ) : (
      <div className="factory-table">
        <table>
          <thead>
            <tr>
              <th>{t("factory.taskId")}</th>
              <th>{t("factory.machine")}</th>
              <th>{t("factory.state")}</th>
              <th>{t("factory.updated")}</th>
              <th>{t("factory.result")}</th>
            </tr>
          </thead>
          <tbody>
            {board.tasks.map((task) => (
              <tr key={task.id}>
                <td>{task.id}</td>
                <td>{task.machineId}</td>
                <td>{status(task.status)}</td>
                <td>{new Date(task.updatedAt).toLocaleString()}</td>
                <td>
                  <FactoryTaskEvidence task={task} status={status} />
                  {task.status === "queued" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/api/factory/tasks/${encodeURIComponent(task.id)}/cancel`,
                            request({}),
                          );
                          await refresh();
                        })
                      }
                    >
                      {t("factory.cancel")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

  </>);
}

function FactoryPatrol({ controller }: { controller: FactoryController }) {
  const { t, settings: draft, setSettings, busy, run, refresh, patrolAt, persistedRoomId } = controller;
  const settings = draft!;
  const roomSaved = Boolean(persistedRoomId) && settings.roomId === persistedRoomId;
  return (<>
    <h4>{t("factory.patrol")}</h4>
    <p>{t("factory.patrolHint")}</p>
    {!roomSaved && <p role="status">{t("factory.saveBeforePatrol")}</p>}
    <label>
      <input
        type="checkbox"
        checked={settings.patrol.enabled}
        disabled={busy || !roomSaved}
        onChange={(e) => {
          const enabled = e.target.checked;
          void run(async () => {
            await api(
              "/api/factory/patrol",
              request({ enabled }, "PATCH"),
            );
            setSettings(old => old ? { ...old, patrol: { ...old.patrol, enabled } } : old);
            await refresh();
          });
        }}
      />
      {t("factory.enablePatrol")}
    </label>
    <button
      disabled={busy || !roomSaved}
      onClick={() =>
        void run(async () => {
          await api("/api/factory/patrol/run", request({}));
          await refresh();
        })
      }
    >
      {t("factory.runPatrol")}
    </button>
    <p>
      {t("factory.lastPatrol", {
        at: formatPatrolTime(patrolAt, t("factory.never")),
      })}
    </p>

  </>);
}

function FactoryCommands({ controller }: { controller: FactoryController }) {
  const { t } = controller;
  return (<>
    <h4>{t("factory.commands")}</h4>
    <p>{t("factory.commandHint")}</p>
    <pre>
      /factory run &lt;machine&gt; &lt;repository&gt; snapshot{"\n"}
      /factory run &lt;machine&gt; &lt;repository&gt; count-files{"\n"}
      /factory run &lt;machine&gt; &lt;repository&gt; read-log
      &lt;logId&gt;{"\n"}/factory status &lt;task&gt;
    </pre>
    <a href="/api/factory/evidence" target="_blank" rel="noreferrer">
      {t("factory.evidence")}
    </a>

  </>);
}

function FactoryTime({ value }: { value?: string }) {
  const { t } = useI18n();
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : t("factory.notAvailable");
}
function formatPatrolTime(value: string, fallback: string) {
  return value ? new Date(value).toLocaleString() : fallback;
}
function FactoryTaskEvidence({ task, status }: { task: Task; status: (value: string) => string }) {
  const { t } = useI18n();
  return (
    <details>
      <summary>{t("factory.details")}</summary>
      <dl>
        <dt>{t("factory.identity")}</dt>
        <dd>{task.identity ?? t("factory.unknown")}</dd>
        <dt>{t("factory.started")}</dt>
        <dd><FactoryTime value={task.startedAt} /></dd>
        <dt>{t("factory.finished")}</dt>
        <dd><FactoryTime value={task.finishedAt} /></dd>
      </dl>
      <pre>
        {JSON.stringify(task.result ?? {}, null, 2)}
      </pre>
      {task.error && <p>{task.error}</p>}
      <ol>
        {task.history.map((h, i) => (
          <li key={i}>
            {status(h.status)} ·{" "}
            {new Date(h.at).toLocaleString()}
          </li>
        ))}
      </ol>
    </details>
  );
}

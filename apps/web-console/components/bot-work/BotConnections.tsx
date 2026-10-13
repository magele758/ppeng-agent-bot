"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
type Invocation = {
  id: string;
  toolName: string;
  state: string;
  result?: unknown;
  error?: string;
};
type Connection = {
  connectorId: string;
  health: string;
  lastProbeAt?: string;
  tools: { name: string; description: string }[];
};
export function BotConnections({ botId }: { botId: string }) {
  const { t } = useI18n();
  const action = useAction();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectorId, setId] = useState("");
  const [spec, setSpec] = useState("");
  const [secretEnv, setSecret] = useState("");
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [cursor,setCursor]=useState<number|null>(null);
  const [selectedConnector, setSelectedConnector] = useState("");
  const [note, setNote] = useState("");
  const [unsupported, setUnsupported] = useState<unknown[]>([]);
  const [tools, setTools] = useState("");
  const base = `/api/bots/${encodeURIComponent(botId)}/connections`;
  const load = async () => {
    const data = (await api(base)) as { connections: Connection[] };
    setConnections(data.connections);
  };
  useEffect(() => {
    setConnections([]);
    setInvocations([]);
    void action.run(load);
  }, [botId]);
  return (
    <section className="ag-panel" data-testid="bot-connections">
      <h3>{t("botWork.connections")}</h3>
      <p>{t("botWork.softwareHint")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const result = (await api(
              `${base}/import`,
              json({
                connectorId,
                spec: JSON.parse(spec),
                ...(secretEnv ? { secretEnv } : {}),
              }),
            )) as { unsupported?: unknown[] };
            setUnsupported(result.unsupported ?? []);
            await load();
          });
        }}
      >
        <label>
          {t("botWork.connectorId")}
          <input
            required
            value={connectorId}
            onChange={(e) => setId(e.target.value)}
          />
        </label>
        <label>
          {t("botWork.secret")}
          <input
            value={secretEnv}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label>
          {t("botWork.spec")}
          <textarea
            required
            rows={5}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
          />
        </label>
        <button disabled={action.busy}>{t("botWork.import")}</button>
      </form>
      <details>
        <summary>{t("botWork.bind")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(
                `${base}/${encodeURIComponent(connectorId)}`,
                json(
                  {
                    ...(secretEnv ? { secretEnv } : {}),
                    ...(tools.trim() ? { tools: JSON.parse(tools) } : {}),
                  },
                  "PUT",
                ),
              );
              await load();
            });
          }}
        >
          <label>
            {t("botWork.executorTools")}
            <textarea
              value={tools}
              onChange={(e) => setTools(e.target.value)}
            />
          </label>
          <button disabled={action.busy || !connectorId}>
            {t("botWork.bind")}
          </button>
        </form>
      </details>
      <Feedback {...action} />
      {!connections.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {connections.map((c) => (
        <article key={c.connectorId}>
          <h4>{c.connectorId}</h4>
          <p>
            {t("botWork.health")}: <Status value={c.health} /> · {c.lastProbeAt}
          </p>
          <ul>
            {c.tools.map((tool) => (
              <li role="presentation" key={tool.name}>
                {tool.name} — {tool.description}
              </li>
            ))}
          </ul>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(
                  `${base}/${encodeURIComponent(c.connectorId)}/probe`,
                  { method: "POST" },
                );
                await load();
              })
            }
          >
            {t("botWork.probe")}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`${base}/${encodeURIComponent(c.connectorId)}`, {
                  method: "DELETE",
                });
                await load();
              })
            }
          >
            {t("botWork.revoke")}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const data = (await api(
                  `${base}/${encodeURIComponent(c.connectorId)}/invocations`,
                )) as { invocations: Invocation[];hasMore?:boolean;nextCursor?:number|null };
                setCursor(data.hasMore?data.nextCursor??null:null);
                setSelectedConnector(c.connectorId);
                setInvocations(data.invocations);
              })
            }
          >
            {t("botWork.invocations")}
          </button>
        </article>
      ))}
      <Result value={unsupported.length ? unsupported : null} />
      {cursor!=null&&<button disabled={action.busy} onClick={()=>void action.run(async()=>{const data=await api(`${base}/${encodeURIComponent(selectedConnector)}/invocations?limit=100&beforeSeq=${cursor}`) as {invocations:Invocation[];hasMore:boolean;nextCursor:number|null};setInvocations(prev=>[...prev,...data.invocations]);setCursor(data.hasMore?data.nextCursor:null);})}>{t('botWork.older')}</button>}
      {invocations.map((inv) => (
        <article key={inv.id}>
          <strong>{inv.toolName}</strong>
          <Status value={inv.state} />
          <Result value={inv.result ?? inv.error} />
          {inv.state === "unknown" && (
            <form onSubmit={(e) => e.preventDefault()}>
              <label>
                {t("botWork.confirmNote")}
                <input
                  required
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              {(["completed", "failed"] as const).map((state) => (
                <button
                  key={state}
                  disabled={action.busy || !note.trim()}
                  onClick={() =>
                    void action.run(async () => {
                      const data = (await api(
                        `${base}/${encodeURIComponent(selectedConnector)}/invocations/${inv.id}/resolve`,
                        json({ state, note }),
                      )) as { invocation: Invocation };
                      setInvocations((prev) =>
                        prev.map((row) =>
                          row.id === inv.id ? data.invocation : row,
                        ),
                      );
                      setNote("");
                    })
                  }
                >
                  {state === "completed"
                    ? t("botWork.confirmedSuccess")
                    : t("botWork.confirmedFailure")}
                </button>
              ))}
            </form>
          )}
        </article>
      ))}
    </section>
  );
}

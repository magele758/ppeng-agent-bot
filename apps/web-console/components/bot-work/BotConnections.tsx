"use client";
import { useEffect, useState } from "react";
import { ownedByBot, shownRows } from "@/lib/bot-panel-reset";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
import { useBotPanelRead } from "./use-bot-panel-read";
import { ConnectionWizard } from "./ConnectionWizard";
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
  healthReason?: string;
  lastProbeAt?: string;
  tools: { name: string; description: string; executor?: { kind: string; method?: string; readOnly?: boolean } }[];
};
export function BotConnections({ botId }: { botId: string }) {
  const { t } = useI18n();
  const action = useAction();
  const panel = useBotPanelRead(botId);
  const [loadedBotId, setLoadedBotId] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectorId, setId] = useState("");
  const [spec, setSpec] = useState("");
  const [secretEnv, setSecret] = useState("");
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [invocationBotId, setInvocationBotId] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [selectedConnector, setSelectedConnector] = useState("");
  const [note, setNote] = useState("");
  const [unsupported, setUnsupported] = useState<unknown[]>([]);
  const [unsupportedBotId, setUnsupportedBotId] = useState("");
  const [tools, setTools] = useState("");
  const [probeFailed, setProbeFailed] = useState(false);
  const visibleConnections = shownRows(botId, loadedBotId, connections);
  const visibleInvocations = shownRows(botId, invocationBotId, invocations);
  const visibleUnsupported = ownedByBot(botId, unsupportedBotId, unsupported);
  const connectionPath = (requestedBotId: string, suffix = "") =>
    `/api/bots/${encodeURIComponent(requestedBotId)}/connections${suffix}`;
  const load = async (requestedBotId: string, signal?: AbortSignal) => {
    const data = await panel.read(
      requestedBotId,
      () =>
        api(connectionPath(requestedBotId), { signal }) as Promise<{ connections: Connection[] }>,
      signal,
    );
    if (!data) return;
    setLoadedBotId(requestedBotId);
    setConnections(data.connections);
  };
  useEffect(() => {
    const ac = new AbortController();
    setProbeFailed(false);
    void action.run(() => load(botId, ac.signal));
    return () => ac.abort();
  }, [botId]);
  return (
    <section className="ag-panel" data-testid="bot-connections">
      <h3>{t("botWork.connections")}</h3>
      <p>{t("botWork.softwareHint")}</p>
      <ConnectionWizard key={botId} botId={botId} ready={loadedBotId === botId} existingIds={visibleConnections.map(connection => connection.connectorId)} onSaved={() => load(botId)} />
      <details>
      <summary>{t("botWork.advancedConnection")}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const requestedBotId = botId;
          void action.run(async () => {
            const parsed = JSON.parse(spec);
            const result = await panel.read(
              requestedBotId,
              () =>
                api(
                  connectionPath(requestedBotId, "/import"),
                  json({
                    connectorId,
                    spec: parsed,
                    ...(secretEnv ? { secretEnv } : {}),
                  }),
                ) as Promise<{ unsupported?: unknown[] }>,
            );
            if (!result) return;
            setUnsupportedBotId(requestedBotId);
            setUnsupported(result.unsupported ?? []);
            await load(requestedBotId);
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
            const requestedBotId = botId;
            void action.run(async () => {
              const saved = await panel.read(requestedBotId, () =>
                api(
                  connectionPath(requestedBotId, `/${encodeURIComponent(connectorId)}`),
                  json(
                    {
                      ...(secretEnv ? { secretEnv } : {}),
                      ...(tools.trim() ? { tools: JSON.parse(tools) } : {}),
                    },
                    "PUT",
                  ),
                ),
              );
              if (!saved) return;
              await load(requestedBotId);
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
      </details>
      <Feedback {...action} />
      {probeFailed && <p role="status">{t("botWork.connectionProbeFailed")}</p>}
      {botId === loadedBotId && !visibleConnections.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {visibleConnections.map((c) => (
        <article key={c.connectorId}>
          <h4>{c.connectorId}</h4>
          <p>
            {t("botWork.health")}: <Status value={c.health} /> · {c.lastProbeAt
              ? <time dateTime={c.lastProbeAt}>{t("botWork.lastConnectionCheck", { time: c.lastProbeAt })}</time>
              : t("botWork.connectionNotChecked")}
          </p>
          {c.healthReason === 'authorization_required' && <p role="alert">{t("botWork.connectionAuthorizationRequired")}</p>}
          <ul>
            {c.tools.map((tool) => (
              <li role="presentation" key={tool.name}>
                {tool.name} — {tool.description}
                <p>{t("botWork.operationScope")}: {tool.executor
                  ? tool.executor.kind === 'http'
                    ? t(['GET', 'HEAD', 'OPTIONS'].includes(tool.executor.method ?? 'GET') ? 'botWork.httpReadScope' : 'botWork.httpWriteScope', { method: tool.executor.method ?? 'GET' })
                    : t(tool.executor.readOnly === true ? 'botWork.mcpReadScope' : 'botWork.mcpWriteScope')
                  : t('botWork.connectionScopeUnknown')}</p>
              </li>
            ))}
          </ul>
          <button
            disabled={action.busy}
            onClick={() => {
              const requestedBotId = botId;
              void action.run(async () => {
                const probed = await panel.read(requestedBotId, () =>
                  api(connectionPath(requestedBotId, `/${encodeURIComponent(c.connectorId)}/probe`), {
                    method: "POST",
                  }) as Promise<{ connection: Connection }>,
                );
                if (!probed) return;
                setProbeFailed(probed.connection.health !== 'ready');
                await load(requestedBotId);
              });
            }}
          >
            {t("botWork.probe")}
          </button>
          <button
            disabled={action.busy}
            onClick={() => {
              const requestedBotId = botId;
              void action.run(async () => {
                const removed = await panel.read(requestedBotId, () =>
                  api(connectionPath(requestedBotId, `/${encodeURIComponent(c.connectorId)}`), {
                    method: "DELETE",
                  }),
                );
                if (!removed) return;
                await load(requestedBotId);
              });
            }}
          >
            {t("botWork.revoke")}
          </button>
          <button
            disabled={action.busy}
            onClick={() => {
              const requestedBotId = botId;
              const connector = c.connectorId;
              void action.run(async () => {
                const data = await panel.read(
                  requestedBotId,
                  () =>
                    api(connectionPath(requestedBotId, `/${encodeURIComponent(connector)}/invocations`)) as Promise<{
                      invocations: Invocation[];
                      hasMore?: boolean;
                      nextCursor?: number | null;
                    }>,
                );
                if (!data) return;
                setInvocationBotId(requestedBotId);
                setCursor(data.hasMore ? (data.nextCursor ?? null) : null);
                setSelectedConnector(connector);
                setInvocations(data.invocations);
              });
            }}
          >
            {t("botWork.invocations")}
          </button>
        </article>
      ))}
      <Result value={visibleUnsupported && visibleUnsupported.length ? visibleUnsupported : null} />
      {botId === invocationBotId && cursor != null && (
        <button
          disabled={action.busy}
          onClick={() => {
            const requestedBotId = botId;
            const before = cursor;
            const connector = selectedConnector;
            void action.run(async () => {
              const data = await panel.read(
                requestedBotId,
                () =>
                  api(
                    connectionPath(
                      requestedBotId,
                      `/${encodeURIComponent(connector)}/invocations?limit=100&beforeSeq=${before}`,
                    ),
                  ) as Promise<{ invocations: Invocation[]; hasMore: boolean; nextCursor: number | null }>,
              );
              if (!data) return;
              setInvocationBotId(requestedBotId);
              setInvocations((prev) => [...prev, ...data.invocations]);
              setCursor(data.hasMore ? data.nextCursor : null);
            });
          }}
        >
          {t("botWork.older")}
        </button>
      )}
      {visibleInvocations.map((inv) => (
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
                  onClick={() => {
                    const requestedBotId = botId;
                    const connector = selectedConnector;
                    void action.run(async () => {
                      const data = await panel.read(
                        requestedBotId,
                        () =>
                          api(
                            connectionPath(
                              requestedBotId,
                              `/${encodeURIComponent(connector)}/invocations/${inv.id}/resolve`,
                            ),
                            json({ state, note }),
                          ) as Promise<{ invocation: Invocation }>,
                      );
                      if (!data) return;
                      setInvocationBotId(requestedBotId);
                      setInvocations((prev) => prev.map((row) => (row.id === inv.id ? data.invocation : row)));
                      setNote("");
                    });
                  }}
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

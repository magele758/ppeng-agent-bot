"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback, Result } from "./shared";
type Entry = {
  id: string;
  scope: string;
  key: string;
  value: string;
  namespace?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  sessionId?: string;
  sourceRefs?: { sessionId: string; messageId: string; seq?: number }[];
};
export function BotMemory({
  botId,
  sessionId,
}: {
  botId: string;
  sessionId: string;
}) {
  const { t } = useI18n();
  const action = useAction();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [context, setContext] = useState<unknown>(null);
  const load = async () => {
    const data = (await api(
      `/api/memory?agentId=${encodeURIComponent(botId)}&limit=200`,
    )) as { entries: Entry[] };
    setEntries(data.entries);
  };
  useEffect(() => {
    void action.run(load);
  }, [botId, sessionId]);
  return (
    <section className="ag-panel" data-testid="bot-memory">
      <h3>{t("memory.title")}</h3>
      <p>{t("botWork.memoryHistoryHint")}</p>
      <button disabled={action.busy} onClick={() => void action.run(load)}>
        {t("botWork.refresh")}
      </button>
      <Feedback {...action} />
      {!entries.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {entries.map((entry) => (
        <article key={entry.id}>
          <strong>{entry.key}</strong>
          <p>{entry.value}</p>
          <button disabled={action.busy} onClick={() => setEditing(entry)}>
            {t("botWork.edit")}
          </button>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api(`/api/memory/${encodeURIComponent(entry.id)}`, {
                  method: "DELETE",
                });
                await load();
              })
            }
          >
            {t("botWork.remove")}
          </button>
          {entry.sourceRefs?.map((source) => (
            <button
              key={source.messageId}
              disabled={action.busy || source.seq == null}
              onClick={() =>
                void action.run(async () =>
                  setContext(
                    await api(
                      `/api/sessions/${encodeURIComponent(source.sessionId)}/history/${source.seq}`,
                    ),
                  ),
                )
              }
            >
              {t("botWork.source")} #{source.seq ?? source.messageId}
            </button>
          ))}
        </article>
      ))}
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api("/api/memory", json(editing));
              setEditing(null);
              await load();
            });
          }}
        >
          <textarea
            required
            aria-label={t("memory.valueLabel")}
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          />
          <button disabled={action.busy}>{t("botWork.save")}</button>
          <button type="button" onClick={() => setEditing(null)}>
            {t("botWork.cancel")}
          </button>
        </form>
      )}
      <Result value={context} />
    </section>
  );
}

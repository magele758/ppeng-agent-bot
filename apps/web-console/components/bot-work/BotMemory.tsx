"use client";
import { useEffect, useState } from "react";
import { ownedByBot, shownRows } from "@/lib/bot-panel-reset";
import { useI18n } from "@/lib/i18n";
import { api, json, useAction, Feedback, Result } from "./shared";
import { useBotPanelRead } from "./use-bot-panel-read";
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
  const panel = useBotPanelRead(botId);
  const [loadedBotId, setLoadedBotId] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draftBotId, setDraftBotId] = useState("");
  const [editing, setEditing] = useState<Entry | null>(null);
  const [contextBotId, setContextBotId] = useState("");
  const [context, setContext] = useState<unknown>(null);
  const visibleEntries = shownRows(botId, loadedBotId, entries);
  const visibleDraft = ownedByBot(botId, draftBotId, editing);
  const visibleContext = ownedByBot(botId, contextBotId, context);
  const reload = async (requestedBotId: string, signal?: AbortSignal) => {
    const data = await panel.read(
      requestedBotId,
      () =>
        api(
          `/api/memory?agentId=${encodeURIComponent(requestedBotId)}&limit=200`,
          { signal },
        ) as Promise<{ entries: Entry[] }>,
      signal,
    );
    if (!data) return;
    setLoadedBotId(requestedBotId);
    setEntries(data.entries);
  };
  useEffect(() => {
    const ac = new AbortController();
    void action.run(() => reload(botId, ac.signal));
    return () => ac.abort();
  }, [botId, sessionId]);
  return (
    <section className="ag-panel" data-testid="bot-memory">
      <h3>{t("memory.title")}</h3>
      <p>{t("botWork.memoryHistoryHint")}</p>
      <button disabled={action.busy} onClick={() => void action.run(() => reload(botId))}>
        {t("botWork.refresh")}
      </button>
      <Feedback {...action} />
      {botId === loadedBotId && !visibleEntries.length && !action.busy && <p>{t("botWork.empty")}</p>}
      {visibleEntries.map((entry) => (
        <article key={entry.id}>
          <strong>{entry.key}</strong>
          <p>{entry.value}</p>
          <button
            disabled={action.busy}
            onClick={() => {
              setDraftBotId(botId);
              setEditing(entry);
            }}
          >
            {t("botWork.edit")}
          </button>
          <button
            disabled={action.busy}
            onClick={() => {
              const requestedBotId = botId;
              void action.run(async () => {
                await api(`/api/memory/${encodeURIComponent(entry.id)}`, {
                  method: "DELETE",
                });
                if (panel.selected() !== requestedBotId) return;
                await reload(requestedBotId);
              });
            }}
          >
            {t("botWork.remove")}
          </button>
          {entry.sourceRefs?.map((source) => (
            <button
              key={source.messageId}
              disabled={action.busy || source.seq == null}
              onClick={() => {
                const requestedBotId = botId;
                void action.run(async () => {
                  const data = await panel.read(requestedBotId, () =>
                    api(
                      `/api/sessions/${encodeURIComponent(source.sessionId)}/history/${source.seq}`,
                    ),
                  );
                  if (!data) return;
                  setContextBotId(requestedBotId);
                  setContext(data);
                });
              }}
            >
              {t("botWork.source")} #{source.seq ?? source.messageId}
            </button>
          ))}
        </article>
      ))}
      {visibleDraft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const requestedBotId = botId;
            const draft = visibleDraft;
            if (panel.selected() !== requestedBotId) return;
            void action.run(async () => {
              await api("/api/memory", json(draft));
              if (panel.selected() !== requestedBotId) return;
              setEditing(null);
              await reload(requestedBotId);
            });
          }}
        >
          <textarea
            required
            aria-label={t("memory.valueLabel")}
            value={visibleDraft.value}
            onChange={(e) => setEditing({ ...visibleDraft, value: e.target.value })}
          />
          <button disabled={action.busy}>{t("botWork.save")}</button>
          <button type="button" onClick={() => setEditing(null)}>
            {t("botWork.cancel")}
          </button>
        </form>
      )}
      <Result value={visibleContext} />
    </section>
  );
}

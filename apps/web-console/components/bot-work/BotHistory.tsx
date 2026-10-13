"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { api, useAction, Feedback, Result, MessageContent } from "./shared";
type Message = {
  id: string;
  seq: number;
  role: string;
  parts: unknown[];
  createdAt?: string;
};
type Page = {
  messages: Message[];
  nextCursor: number | null;
  hasMore: boolean;
};
export function BotHistory({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const action = useAction();
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [context, setContext] = useState<Message[]>([]);
  const load = async (older = false) => {
    const params = new URLSearchParams({ limit: "50", query });
    if (older && cursor != null) params.set("beforeSeq", String(cursor));
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());
    const data = (await api(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?${params}`,
    )) as Page;
    setRows((prev) => (older ? [...data.messages, ...prev] : data.messages));
    setCursor(data.hasMore ? data.nextCursor : null);
    setContext([]);
  };
  useEffect(() => {
    setRows([]);
    setCursor(null);
    void action.run(() => load());
  }, [sessionId]);
  return (
    <section data-testid="bot-history" className="ag-panel">
      <h3>{t("botWork.history")}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() => load());
        }}
      >
        <label>
          {t("botWork.query")}
          <input
            data-testid="bot-history-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          {t("botWork.from")}
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          {t("botWork.to")}
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button data-testid="bot-history-search" disabled={action.busy}>
          {t("botWork.search")}
        </button>
      </form>
      <Feedback {...action} />
      {!rows.length && !action.busy && (
        <p data-testid="bot-history-empty">{t("botWork.empty")}</p>
      )}
      {cursor != null && (
        <button
          disabled={action.busy}
          onClick={() => void action.run(() => load(true))}
        >
          {t("botWork.older")}
        </button>
      )}
      <div style={{ maxHeight: 440, overflow: "auto" }}>
        {rows.map((m) => (
          <article key={m.id}>
            <small>
              {m.role} · {m.createdAt} · #{m.seq}
            </small>
            <MessageContent parts={m.parts} />
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const data = (await api(
                    `/api/sessions/${encodeURIComponent(sessionId)}/history/${m.seq}`,
                  )) as { messages: Message[] };
                  setContext(data.messages);
                })
              }
            >
              {t("botWork.context")}
            </button>
          </article>
        ))}
      </div>
      {context.length > 0 && (
        <aside aria-label={t("botWork.context")}>
          {context.map((m) => (
            <article key={m.id}>
              <small>
                #{m.seq} {m.role}
              </small>
              <MessageContent parts={m.parts} />
            </article>
          ))}
        </aside>
      )}
    </section>
  );
}

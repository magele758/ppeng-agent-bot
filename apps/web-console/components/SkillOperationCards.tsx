"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useSkillBots } from "./BotSkillSharing";
type Action =
  "create" | "update" | "share" | "unshare" | "set_sharing" | "delete";
type Status = "pending" | "processing" | "saved" | "rejected" | "failed";
type Operation = {
  id: string;
  name: string;
  affectedBotIds: string[];
  input: { action: Action; reason?: string; summary?: string };
  status: Status;
  error?: string;
};
export function SkillOperationCards({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [rows, setRows] = useState<Operation[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/skill-operations`;
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = (await api(endpoint)) as { operations: Operation[] };
        if (alive) setRows(data.operations);
      } catch {}
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [endpoint]);
  async function decide(id: string, action: string) {
    setBusy(id);
    setError("");
    try {
      const data = (await api(
        `${endpoint}/${encodeURIComponent(id)}/${action}`,
        { method: "POST" },
      )) as { operation: Operation };
      setRows((rows) => rows.map((r) => (r.id === id ? data.operation : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div>
      {rows.map((row) => (
        <section
          className="skill-capture-card"
          role="dialog"
          aria-modal="false"
          aria-label={t("skillProposals.manageTitle")}
          key={row.id}
        >
          <h4>
            {t(`skillProposals.action_${row.input.action}`)} · {row.name}
          </h4>
          <p>{row.input.reason}</p>
          <p>{row.input.summary}</p>
          <p>
            {t("skillProposals.recipients", {
              names: row.affectedBotIds
                .map((id) => bots.find((b) => b.id === id)?.name ?? id)
                .join(", "),
            })}
          </p>
          {row.status === "pending" ? (
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={() => void decide(row.id, "confirm")}
              >
                {t("skillProposals.confirmOperation")}
              </button>{" "}
              <button
                className="btn btn-ghost btn-sm"
                disabled={!!busy}
                onClick={() => void decide(row.id, "reject")}
              >
                {t("skillProposals.reject")}
              </button>
            </>
          ) : (
            <p role="status">{t(`skillProposals.op_${row.status}`)}</p>
          )}
          {row.error && <p role="alert">{row.error}</p>}
        </section>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

"use client";
import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import { useI18n, type MessageKey } from "@/lib/i18n";
export const json = (value: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
export function Feedback({ busy, error }: { busy: boolean; error: string }) {
  const { t } = useI18n();
  return (
    <>
      {busy && <p role="status">{t("botWork.loading")}</p>}
      {error && <p role="alert">{t("botWork.error", { error })}</p>}
    </>
  );
}
export function Result({ value }: { value: unknown }) {
  return value == null ? null : (
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export { api };

export function Status({ value }: { value: string }) {
  const { t } = useI18n();
  const known = [
    "queued",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "unknown",
    "skipped",
    "idle",
    "active",
    "paused",
    "configured",
    "ready",
    "degraded",
    "unavailable",
  ];
  return (
    <span>
      {known.includes(value)
        ? t(`botWork.states.${value}` as MessageKey)
        : value}
    </span>
  );
}

export function MessageContent({ parts }: { parts: unknown[] }) {
  const { t } = useI18n();
  return (
    <>
      {parts.map((raw, index) => {
        const part = raw as {
          type?: string;
          text?: string;
          content?: unknown;
          name?: string;
        };
        if (part.type === "text")
          return (
            <p key={index} style={{ whiteSpace: "pre-wrap" }}>
              {part.text}
            </p>
          );
        return (
          <details key={index}>
            <summary>{part.name ?? t("botWork.result")}</summary>
            <Result value={part.content ?? part.text ?? raw} />
          </details>
        );
      })}
    </>
  );
}

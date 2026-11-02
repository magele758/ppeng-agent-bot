"use client";
import { usePreferenceRevision } from './usePreferenceRevision';
import { preferenceStorage } from '@/lib/user-preference-storage';
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import "./skill-capture.css";
import { useSkillBots } from "./BotSkillSharing";
import {
  skillOperationCardIsBar,
  skillOperationCardStatus,
  visibleSkillOperationCards,
} from "./skill-operation-card-model";
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
export function SkillOperationCards({ sessionId, onLayoutChange }: { sessionId: string; onLayoutChange?: () => void }) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const [rows, setRows] = useState<Operation[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<Set<string>>(new Set());
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const [storageError, setStorageError] = useState(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  const preferenceRevision = usePreferenceRevision();
  const storageKey = 'lab.skillOperationDismissed.' + sessionId;
  const callback = useRef(onLayoutChange);
  callback.current = onLayoutChange;
  useEffect(() => {
    try {
      const ids: unknown = JSON.parse(preferenceStorage.getItem(storageKey) ?? '[]');
      setDismissed(new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []));
    } catch { setDismissed(new Set()); }
    setToggled(new Set());
    setStorageError(false);
  }, [storageKey, preferenceRevision]);
  useLayoutEffect(() => {
    callback.current?.();
    if (focusTarget.current?.isConnected) {
      focusTarget.current.focus({ preventScroll: true });
      focusTarget.current.scrollIntoView({ block: 'nearest' });
    }
    focusTarget.current = null;
  }, [rows, dismissed, toggled, confirming]);
  function dismiss(id: string, button: HTMLButtonElement) {
    const card = button.closest('.skill-capture-card');
    focusTarget.current = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null;
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try { preferenceStorage.setItem(storageKey, JSON.stringify([...next])); }
    catch { setStorageError(true); }
  }
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/skill-operations`;
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = (await api(endpoint)) as { operations: Operation[] };
        if (alive) setRows(current => JSON.stringify(current) === JSON.stringify(data.operations) ? current : data.operations);
      } catch {}
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [endpoint]);
  function stopConfirming(id: string) {
    setConfirming((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }
  async function decide(id: string, action: "confirm" | "reject") {
    if (action === "confirm") setConfirming((current) => new Set(current).add(id));
    setBusy(id);
    setError("");
    try {
      const data = (await api(
        `${endpoint}/${encodeURIComponent(id)}/${action}`,
        { method: "POST" },
      )) as { operation: Operation };
      setRows((rows) => rows.map((r) => (r.id === id ? data.operation : r)));
      if (action === "confirm") stopConfirming(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (action === "confirm") stopConfirming(id);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="skill-capture-list">
      {storageError && <p role="status">{t("skillProposals.captureDismissStorageError")}</p>}
      {visibleSkillOperationCards(rows, dismissed, confirming).map((row) => {
        const bar = skillOperationCardIsBar(row, confirming);
        const status = skillOperationCardStatus(row, confirming);
        const open = bar ? toggled.has(row.id) : !toggled.has(row.id);
        return (
        <section
          className={bar && !open ? "skill-capture-card skill-capture-card--bar" : "skill-capture-card"}
          tabIndex={-1}
          data-testid={`skill-operation-${row.id}`}
          role="dialog"
          aria-modal="false"
          aria-label={t("skillProposals.manageTitle")}
          key={row.id}
        >
          <h4>
            {t(`skillProposals.action_${row.input.action}`)} · {row.name}
          </h4>
          {bar ? <p role="status">{t(`skillProposals.op_${status}`)}</p> : null}
          <div id={`operation-details-${row.id}`} hidden={!open}>
          <p>{row.input.reason}</p>
          <p>{row.input.summary}</p>
          <p>
            {t("skillProposals.recipients", {
              names: row.affectedBotIds
                .map((id) => bots.find((b) => b.id === id)?.name ?? id)
                .join(", "),
            })}
          </p>
          {row.error && <p role="alert">{row.error}</p>}
          </div>
          {!bar && row.status === "pending" ? (
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
          ) : null}
          {bar && <div className="skill-capture-actions">
            <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls={`operation-details-${row.id}`} onClick={() => setToggled(current => { const next = new Set(current); if(next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })}>{t(open ? 'skillProposals.captureCollapse' : 'skillProposals.captureExpand')}</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={t('skillProposals.dismissResult')} onClick={event => dismiss(row.id, event.currentTarget)}>{t('skillProposals.dismissResult')}</button>
          </div>}
        </section>
      );})}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

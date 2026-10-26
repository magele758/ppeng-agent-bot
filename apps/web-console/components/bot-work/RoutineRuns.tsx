"use client";
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useLab } from "../shell/LabProvider";
import { api, json, useAction, Feedback, Result, Status } from "./shared";
type Run = {
  recovery?:{resume:boolean;reason:string;checkpointSeq?:number};
  id: string;
  status: string;
  precheckOutcome?: string;
  failureClass?: string;
  sessionId?: string;
  result?: unknown;
  error?: string;
  scheduledAt: string;
  attempt: number;
  requiresEffectVerification?: boolean;
  publication?: 'pending'|'approved'|'rejected';
  notificationReason?:string;
  job?:{metadata:{roomId?:string}};
};
export function RoutineRuns({ jobId }: { jobId: string }) {
  const { t } = useI18n();
  const lab = useLab();
  const action = useAction();
  const recoveryDetail=(reason:string)=>['approval_rejected','session_not_resumable','missing_checkpoint','checkpoint_not_retained','effects_unverified','unsafe_tail','open_tool_wave'].includes(reason)?t(`botWork.recoveryReasons.${reason}` as MessageKey):'';
  const [runs, setRuns] = useState<Run[]>([]);
  const [cursor, setCursor] = useState<number | undefined>();
  const [paged, setPaged] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Run | null>(null);
  const [confirmedUnknown, setConfirmedUnknown] = useState<Record<string,boolean>>({});
  const load = async () => {
    const data = (await api(`/api/cron/jobs/${jobId}/runs`)) as { runs: Run[]; nextCursor?: number };
    setRuns(data.runs);
    setCursor(data.nextCursor);setPaged(false);
    setLoaded(true);
  };
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    const timer = setInterval(() => {
      void api(`/api/cron/jobs/${jobId}/runs`)
        .then((data) => {
          if (active) {
            const page = data as {runs:Run[];nextCursor?:number};
            setRuns(prev => paged ? Array.from(new Map([...prev.filter(x => !["queued", "running", "waiting_approval", "unknown"].includes(x.status)), ...page.runs.filter(x => ["queued", "running", "waiting_approval", "unknown"].includes(x.status) || prev.some(p => p.id === x.id))].map(x=>[x.id,x])).values()) : page.runs);
            if (!paged) setCursor(page.nextCursor);
          }
        })
        .catch(() => {});
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [loaded, jobId, paged]);
  return (
    <div>
      <button
        type="button"
        disabled={action.busy}
        onClick={() => void action.run(load)}
      >
        {t("botWork.runs")}
      </button>
      <Feedback {...action} />
      {loaded && !runs.length && <p>{t("botWork.empty")}</p>}
      {runs.map((r) => (
        <article key={r.id}>
          <span>
            {r.scheduledAt} · {r.precheckOutcome==='failed'?t('botWork.precheckFailed'):r.precheckOutcome==='no_change'?t('botWork.precheckNoChange'):<Status value={r.status} />} · {r.attempt}
          </span>
          {r.publication==='pending'&&<div role="status">
            <p>{t('botWork.routinePublicationPending')}</p>
            <p>{t('botWork.routineOutput')}: {r.job?.metadata.roomId??t('botWork.routineOutputChat')}</p>
            <Result value={r.result}/>
            {[true,false].map(approved=><button key={String(approved)} type="button" disabled={action.busy} onClick={()=>void action.run(async()=>{await api(`/api/cron/runs/${r.id}/publication`,json({approved}));await load();})}>{t(approved?'botWork.routinePublish':'botWork.routineReject')}</button>)}
          </div>}
          {r.recovery&&<p>{t(r.recovery.resume?'botWork.recoveryResumed':'botWork.recoveryBlocked')} · {recoveryDetail(r.recovery.reason)}{r.recovery.checkpointSeq!==undefined?' · '+t('botWork.recoveryCheckpoint',{seq:r.recovery.checkpointSeq}):''}</p>}
          {r.notificationReason&&<p>{t(['quiet_hours','budget'].includes(r.notificationReason)?'botWork.attentionDeferred':r.notificationReason==='merged'?'botWork.attentionMerged':r.notificationReason==='unchanged'?'botWork.routineUnchanged':r.notificationReason==='rejected'?'botWork.routineRejected':'botWork.routineBelowThreshold')}</p>}
          {r.failureClass&&<span>{r.failureClass==='transient'?t('botWork.failureTransient'):t('botWork.failureHard')}</span>}
          <button
            type="button"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const data = (await api(`/api/cron/runs/${r.id}`)) as {
                  run: Run;
                };
                setSelected(data.run);
              })
            }
          >
            {t("botWork.details")}
          </button>
          {(r.status === "unknown" || r.requiresEffectVerification) && (
            <label>
              <input
                type="checkbox"
                checked={Boolean(confirmedUnknown[r.id])}
                onChange={(e) => setConfirmedUnknown(prev=>({...prev,[r.id]:e.target.checked}))}
              />
              {t("botWork.confirmUnknown")}
            </label>
          )}
          {["failed", "cancelled", "unknown"].includes(r.status) && (
            <button
              type="button"
              disabled={
                action.busy || ((r.status === "unknown" || r.requiresEffectVerification) && !confirmedUnknown[r.id])
              }
              onClick={() =>
                void action.run(async () => {
                  await api(
                    `/api/cron/runs/${r.id}/retry`,
                    json({ confirmUnknown:Boolean(confirmedUnknown[r.id]) }),
                  );
                  setConfirmedUnknown(prev=>({...prev,[r.id]:false}));
                  await load();
                })
              }
            >
              {t("botWork.retry")}
            </button>
          )}
          {["queued", "running", "waiting_approval"].includes(r.status) && (
            <button
              type="button"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/cron/runs/${r.id}/cancel`, {
                    method: "POST",
                  });
                  await load();
                })
              }
            >
              {t("botWork.cancel")}
            </button>
          )}
          {r.sessionId && (
            <button
              type="button"
              onClick={() =>
                void lab.openSession(r.sessionId!, { focusChat: true })
              }
            >
              {t("botWork.session")}
            </button>
          )}
        </article>
      ))}
      {cursor !== undefined && <button disabled={action.busy} onClick={() => void action.run(async () => {
        const page = await api(`/api/cron/jobs/${jobId}/runs?before=${cursor}`) as {runs:Run[];nextCursor?:number};
        setRuns(prev => Array.from(new Map([...prev, ...page.runs].map(x=>[x.id,x])).values()));
        setCursor(page.nextCursor);setPaged(true);
      })}>{t("botWork.older")}</button>}
      {selected && <Result value={selected} />}
    </div>
  );
}

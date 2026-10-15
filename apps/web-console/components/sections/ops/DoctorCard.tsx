'use client';

import { useCallback, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  splitDoctorChecks,
  type DoctorCheckLike,
  type DoctorReportLike,
  type DoctorSeverity
} from '@/lib/ops-health';

const SEVERITY_KEY: Record<DoctorSeverity, MessageKey> = {
  ok: 'ops.health.severityOk',
  warn: 'ops.health.severityWarn',
  fail: 'ops.health.severityFail'
};

function CheckRow({ check }: { check: DoctorCheckLike }) {
  const { t } = useI18n();
  return (
    <li className={`ops-check ops-check--${check.severity}`} data-testid={`doctor-${check.id}`}>
      <div className="ops-check__head">
        <span className={`ops-tag ops-tag--${check.severity}`}>{t(SEVERITY_KEY[check.severity])}</span>
        <strong>{check.title}</strong>
      </div>
      {check.detail ? <div className="muted ops-check__detail">{check.detail}</div> : null}
      {check.hint ? (
        <div className="ops-check__hint">
          <strong>{t('ops.health.diagnoseHintLabel')}</strong>：{check.hint}
        </div>
      ) : null}
    </li>
  );
}

/** One-click read-only diagnostics: failures and warnings first, passes folded away. */
export function DoctorCard({
  onReport,
  onLoadFailed
}: {
  onReport?: (report: DoctorReportLike | null) => void;
  onLoadFailed?: (failed: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<DoctorReportLike | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = (await api('/api/doctor')) as DoctorReportLike;
      setReport(next);
      onReport?.(next);
      onLoadFailed?.(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onLoadFailed?.(true);
    } finally {
      setBusy(false);
    }
  }, [onLoadFailed, onReport]);

  const split = useMemo(() => (report ? splitDoctorChecks(report.checks) : null), [report]);
  const checkedAt = report ? new Date(report.checkedAt).toLocaleTimeString(locale) : '';

  return (
    <div className="card" id="card-doctor">
      <div className="card-head">
        <h3>{t('ops.health.diagnoseTitle')}</h3>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          id="btnDoctor"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? t('ops.health.diagnoseRunning') : report ? t('ops.health.diagnoseRerun') : t('ops.health.diagnoseRun')}
        </button>
      </div>
      <p className="muted ops-cfg__desc">{t('ops.health.diagnoseHint')}</p>

      {err ? (
        <div className="ops-cfg__error" role="alert">
          {t('ops.health.diagnoseFailed')}: {err}
        </div>
      ) : null}

      {!report || !split ? (
        err ? null : <p className="muted ops-cfg__none">{t('ops.health.diagnoseNotRun')}</p>
      ) : (
        <div data-testid="doctor-report">
          <p className="ops-doctor__summary" data-testid="doctor-summary">
            {t('ops.health.diagnoseSummary', {
              ok: report.summary.ok,
              warn: report.summary.warn,
              fail: report.summary.fail
            })}
            <span className="muted"> · {t('ops.health.diagnoseCheckedAt', { time: checkedAt })}</span>
          </p>
          {split.attention.length === 0 ? (
            <div className="ops-doctor__allok" role="status">
              <strong>{t('ops.health.diagnoseAllOk')}</strong>
              <span className="muted"> {t('ops.health.diagnoseAllOkDetail', { n: report.checks.length })}</span>
            </div>
          ) : (
            <>
              <div className="muted ops-cfg__group-title">{t('ops.health.diagnoseAttention')}</div>
              <ul className="ops-checks" data-testid="doctor-attention">
                {split.attention.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </>
          )}
          {split.passed.length > 0 ? (
            <details className="ops-doctor__passed">
              <summary>{t('ops.health.diagnosePassed', { n: split.passed.length })}</summary>
              <ul className="ops-checks">
                {split.passed.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useMemo, useState } from 'react';
import { evolutionEntryVisible } from '@/lib/evolution-surface';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { attentionItems, type EffectiveConfigPayload } from '@/lib/effective-config';
import {
  activityState,
  overallHealth,
  selfHealTone,
  type DoctorReportLike,
  type HealthLevel,
  type HealthReason,
  type SelfHealRunLike
} from '@/lib/ops-health';
import { EffectiveConfigCard } from '../../EffectiveConfigCard';
import { useLab } from '../../shell/LabProvider';
import { DoctorCard } from './DoctorCard';
import { useOpsStatus } from './useOpsStatus';

const LEVEL_TITLE: Record<HealthLevel, MessageKey> = {
  ok: 'ops.health.levelOk',
  warn: 'ops.health.levelWarn',
  fail: 'ops.health.levelFail'
};

const SELF_HEAL_STATUS_KEY: Record<string, MessageKey> = {
  pending: 'ops.health.selfHealStatusPending',
  running_tests: 'ops.health.selfHealStatusRunningTests',
  fixing: 'ops.health.selfHealStatusFixing',
  tests_passed: 'ops.health.selfHealStatusTestsPassed',
  merging: 'ops.health.selfHealStatusMerging',
  restart_pending: 'ops.health.selfHealStatusRestartPending',
  completed: 'ops.health.selfHealStatusCompleted',
  failed: 'ops.health.selfHealStatusFailed',
  blocked: 'ops.health.selfHealStatusBlocked',
  stopped: 'ops.health.selfHealStatusStopped'
};

function reasonText(
  reason: HealthReason,
  counts: { doctorFail: number; doctorWarn: number; configWarn: number },
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  switch (reason) {
    case 'unreachable':
      return t('ops.health.reasonUnreachable');
    case 'notReady':
      return t('ops.health.reasonNotReady');
    case 'doctorFail':
      return t('ops.health.reasonDoctorFail', { n: counts.doctorFail });
    case 'doctorWarn':
      return t('ops.health.reasonDoctorWarn', { n: counts.doctorWarn });
    case 'configWarn':
      return t('ops.health.reasonConfigWarn', { n: counts.configWarn });
    default: {
      const _exhaustive: never = reason;
      throw new Error(`unhandled health reason: ${_exhaustive}`);
    }
  }
}

function StatusCard({
  title,
  tone,
  headline,
  children,
  testId
}: {
  title: string;
  tone: 'ok' | 'warn' | 'fail' | 'run' | 'idle';
  headline: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <div className={`card ops-card ops-card--${tone}`} data-testid={testId}>
      <div className="ops-card__title">
        <span className="ops-dot" aria-hidden="true" />
        {title}
      </div>
      <div className="ops-card__headline">{headline}</div>
      {children ? <div className="ops-card__body">{children}</div> : null}
    </div>
  );
}

function SelfHealRuns({ runs }: { runs: SelfHealRunLike[] }) {
  const { t, locale } = useI18n();
  if (runs.length === 0) return <p className="muted ops-cfg__none">{t('ops.health.selfHealNoRuns')}</p>;
  return (
    <details className="ops-card__details">
      <summary>{t('ops.health.selfHealRecent')}</summary>
      <ul className="ops-runs">
        {runs.map((r) => {
          const tone = selfHealTone(r.status);
          const labelKey = SELF_HEAL_STATUS_KEY[r.status];
          const note = r.blockReason || r.lastErrorSummary;
          return (
            <li key={r.id} className={`ops-run ops-run--${tone}`}>
              <div className="ops-run__head">
                <span className={`ops-tag ops-tag--${tone}`}>{labelKey ? t(labelKey) : r.status}</span>
                {r.fixIteration ? (
                  <span className="muted">{t('ops.health.selfHealIteration', { n: r.fixIteration })}</span>
                ) : null}
                {r.updatedAt ? (
                  <span className="muted">
                    {t('ops.health.selfHealUpdated', { time: new Date(r.updatedAt).toLocaleString(locale) })}
                  </span>
                ) : null}
              </div>
              {r.worktreeBranch ? <code className="muted ops-run__branch">{r.worktreeBranch}</code> : null}
              {note && tone === 'bad' ? <div className="ops-run__note">{note}</div> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function HealthView() {
  const { t, locale } = useI18n();
  const { serverMeta } = useLab();
  const { status, busy, reload } = useOpsStatus({ withRuns: true });
  const [doctor, setDoctor] = useState<DoctorReportLike | null>(null);
  const [config, setConfig] = useState<EffectiveConfigPayload | null>(null);

  const onConfig = useCallback((payload: EffectiveConfigPayload) => setConfig(payload), []);
  const onDoctor = useCallback((report: DoctorReportLike | null) => setDoctor(report), []);

  const configWarnings = config ? attentionItems(config.items).length : 0;
  const verdict = overallHealth({
    reachable: status.reachable,
    ready: status.ready,
    doctor,
    configWarnings
  });
  const level = verdict.level;

  const heal = status.selfHealActive?.length ?? 0;
  const showEvolution = evolutionEntryVisible();
  const evo = status.evolution?.activeWorktrees ?? 0;
  const healBad = (status.selfHealRuns ?? []).some((r) => selfHealTone(r.status) === 'bad') && heal === 0;

  const counts = useMemo(
    () => ({
      doctorFail: doctor?.summary.fail ?? 0,
      doctorWarn: doctor?.summary.warn ?? 0,
      configWarn: configWarnings
    }),
    [doctor, configWarnings]
  );

  const serviceHeadline = !status.loaded
    ? t('ops.health.levelChecking')
    : !status.reachable
      ? t('ops.health.serviceDown')
      : status.ready === false
        ? t('ops.health.serviceNotReady')
        : t('ops.health.serviceUp');
  const serviceTone = !status.loaded ? 'idle' : !status.reachable || status.ready === false ? 'fail' : 'ok';

  return (
    <div className="ops-health" data-testid="ops-health">
      <div
        className={`ops-banner ops-banner--${status.loaded ? level : 'checking'}`}
        role="status"
        aria-label={t('ops.health.overallAria')}
        data-testid="ops-overall"
        data-level={status.loaded ? level : 'checking'}
      >
        <span className="ops-dot ops-dot--lg" aria-hidden="true" />
        <div className="ops-banner__main">
          <div className="ops-banner__title">{status.loaded ? t(LEVEL_TITLE[level]) : t('ops.health.levelChecking')}</div>
          <div className="ops-banner__desc">
            {!status.loaded
              ? null
              : verdict.reasons.length === 0
                ? t('ops.health.allGood')
                : verdict.reasons.map((r) => (
                    <div key={r}>{reasonText(r, counts, t)}</div>
                  ))}
          </div>
        </div>
        <div className="ops-banner__side">
          {status.updatedAt ? (
            <span className="muted small">
              {t('ops.health.updatedAt', { time: new Date(status.updatedAt).toLocaleTimeString(locale) })}
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reload()}>
            {t('ops.health.refresh')}
          </button>
        </div>
      </div>

      <div className="ops-cards" role="group" aria-label={t('ops.health.cardsAria')}>
        <StatusCard
          testId="ops-card-service"
          title={t('ops.health.serviceTitle')}
          tone={serviceTone}
          headline={serviceHeadline}
        >
          {status.reachable ? (
            <>
              <div className="muted">
                {status.ready === true
                  ? t('ops.health.serviceReady')
                  : status.ready === false
                    ? t('ops.health.serviceNotReady')
                    : t('ops.health.serviceUnknown')}
              </div>
              {serverMeta ? (
                <div className="muted small">
                  {t('ops.health.serviceMeta', {
                    name: serverMeta.name,
                    version: serverMeta.version,
                    adapter: serverMeta.adapter ?? '—'
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </StatusCard>

        <StatusCard
          testId="ops-card-selfheal"
          title={t('ops.health.selfHealTitle')}
          tone={status.selfHealActive == null ? 'idle' : heal > 0 ? 'run' : healBad ? 'warn' : 'idle'}
          headline={
            status.selfHealActive == null
              ? t('ops.health.selfHealUnavailable')
              : activityState(heal) === 'running'
                ? t('ops.health.selfHealRunning', { n: heal })
                : t('ops.health.selfHealIdle')
          }
        >
          {status.selfHealRuns ? <SelfHealRuns runs={status.selfHealRuns} /> : null}
        </StatusCard>

        {showEvolution ? (
          <StatusCard
            testId="ops-card-evolution"
            title={t('ops.health.evolutionTitle')}
            tone={status.evolution == null ? 'idle' : evo > 0 ? 'run' : 'idle'}
            headline={
              status.evolution == null
                ? t('ops.health.evolutionUnavailable')
                : activityState(evo) === 'running'
                  ? t('ops.health.evolutionRunning', { n: evo })
                  : t('ops.health.evolutionIdle')
            }
          >
            {status.evolution ? (
              <div className="muted small">
                {t('ops.health.evolutionCounts', {
                  success: status.evolution.counts.success ?? 0,
                  failure: status.evolution.counts.failure ?? 0,
                  skip: status.evolution.counts.skip ?? 0
                })}
              </div>
            ) : null}
            <a className="btn btn-ghost btn-sm ops-card__link" href="/evolution">
              {t('ops.health.evolutionOpen')}
            </a>
          </StatusCard>
        ) : null}
      </div>

      <DoctorCard onReport={onDoctor} />
      <EffectiveConfigCard onLoaded={onConfig} />
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api } from './shared';
import styles from './bot-team-work.module.css';

type Metrics = {
  from: string;
  to: string;
  tasks: number;
  reviewed: number;
  accepted: number;
  acceptanceRate: number | null;
  firstAcceptedDeliveryMs: number | null;
  recordedHumanInterventions: number;
  recoveryCandidates: number;
  recovered: number;
  recoveryRate: number | null;
  knownCostDeliveries: number;
  costPerAcceptedDeliveryUsd: number | null;
};

const DAY_OPTIONS = [7, 30, 90] as const;

function formatPercent(value: number | null, missing: string): string {
  return value === null ? missing : `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | null, missing: string, formatSec: (seconds: string) => string): string {
  return ms === null ? missing : formatSec((ms / 1000).toFixed(1));
}

function formatUsd(cost: number | null, missing: string): string {
  return cost === null ? missing : `$${cost.toFixed(4)}`;
}

function MetricsSummaryList({ metrics }: { metrics: Metrics }) {
  const { t } = useI18n();
  const missing = t('botWork.metricMissing');
  const firstDelivery = formatDuration(
    metrics.firstAcceptedDeliveryMs,
    missing,
    (seconds) => t('botWork.metricSeconds', { seconds }),
  );
  return (
    <>
      <p className={styles.metricsRange}>{metrics.from} — {metrics.to}</p>
      <dl className={styles.metricsGrid}>
        <dt>{t('botWork.metricFirstDelivery')}</dt>
        <dd>{firstDelivery}</dd>
        <dt>{t('botWork.metricAcceptance')}</dt>
        <dd>{formatPercent(metrics.acceptanceRate, missing)} ({metrics.accepted}/{metrics.reviewed})</dd>
        <dt>{t('botWork.metricInterventions')}</dt>
        <dd>{metrics.recordedHumanInterventions}</dd>
        <dt>{t('botWork.metricRecovery')}</dt>
        <dd>{formatPercent(metrics.recoveryRate, missing)} ({metrics.recovered}/{metrics.recoveryCandidates})</dd>
        <dt>{t('botWork.metricCost')}</dt>
        <dd>{formatUsd(metrics.costPerAcceptedDeliveryUsd, missing)}</dd>
      </dl>
      <p className={styles.metricsNote}>
        {t('botWork.metricsDefinition', {
          tasks: metrics.tasks,
          reviewed: metrics.reviewed,
          costs: metrics.knownCostDeliveries,
          accepted: metrics.accepted,
        })}
      </p>
      <p className={styles.metricsNote}>{t('botWork.metricsBillingHint')}</p>
    </>
  );
}

function MetricsStatus({ metrics, error }: { metrics: Metrics | null; error: string }) {
  const { t } = useI18n();
  if (error) return <p role="alert">{error}</p>;
  if (!metrics) return <p role="status">{t('botWork.loading')}</p>;
  return <MetricsSummaryList metrics={metrics} />;
}

export function BotProductMetrics() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    setMetrics(null);
    setError('');
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    void api(`/api/bot-work/metrics?${query}`, { signal: ac.signal })
      .then((data) => {
        if (!ac.signal.aborted) setMetrics((data as { metrics: Metrics }).metrics);
      })
      .catch((failure) => {
        if (!ac.signal.aborted) setError(String(failure));
      });
    return () => ac.abort();
  }, [days, revision]);

  return (
    <details className={styles.metricsDetails} data-testid="bot-product-metrics">
      <summary className={styles.metricsSummary}>{t('botWork.productMetrics')}</summary>
      <div className={styles.metricsPopover}>
        <div className={styles.metricsControls}>
          <label className={styles.metricsLabel}>
            {t('botWork.metricsRange')}
            <select
              className={styles.metricsSelect}
              aria-label={t('botWork.metricsRange')}
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {DAY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t('botWork.metricsDays', { days: value })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setRevision((value) => value + 1)}
          >
            {t('botWork.refresh')}
          </button>
        </div>
        <MetricsStatus metrics={metrics} error={error} />
      </div>
    </details>
  );
}

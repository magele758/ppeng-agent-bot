'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api } from './shared';

type Metrics = {
  from: string; to: string; tasks: number; reviewed: number; accepted: number;
  acceptanceRate: number | null; firstAcceptedDeliveryMs: number | null;
  recordedHumanInterventions: number; recoveryCandidates: number; recovered: number;
  recoveryRate: number | null; knownCostDeliveries: number; costPerAcceptedDeliveryUsd: number | null;
};
export function BotProductMetrics() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    setMetrics(null);setError('');
    const to = new Date(), from = new Date(to.getTime() - days * 86400000);
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    void api(`/api/bot-work/metrics?${query}`, { signal: ac.signal }).then(data => {
      if(!ac.signal.aborted)setMetrics((data as {metrics:Metrics}).metrics);
    }).catch(failure => {if(!ac.signal.aborted)setError(String(failure));});
    return () => ac.abort();
  }, [days, revision]);
  const missing = t('botWork.metricMissing');
  const percent = (value: number | null) => value === null ? missing : `${(value * 100).toFixed(1)}%`;
  return <details data-testid="bot-product-metrics">
    <summary>{t('botWork.productMetrics')}</summary>
    <label>{t('botWork.metricsRange')}<select aria-label={t('botWork.metricsRange')} value={days} onChange={event => setDays(Number(event.target.value))}>
      {[7,30,90].map(value => <option key={value} value={value}>{t('botWork.metricsDays', { days: value })}</option>)}
    </select></label>
    <button type="button" onClick={() => setRevision(value => value + 1)}>{t('botWork.refresh')}</button>
    {error && <p role="alert">{error}</p>}
    {!metrics && !error && <p role="status">{t('botWork.loading')}</p>}
    {metrics && <>
      <p>{metrics.from} — {metrics.to}</p>
      <dl>
        <dt>{t('botWork.metricFirstDelivery')}</dt><dd>{metrics.firstAcceptedDeliveryMs === null ? missing : t('botWork.metricSeconds', { seconds: (metrics.firstAcceptedDeliveryMs/1000).toFixed(1) })}</dd>
        <dt>{t('botWork.metricAcceptance')}</dt><dd>{percent(metrics.acceptanceRate)} ({metrics.accepted}/{metrics.reviewed})</dd>
        <dt>{t('botWork.metricInterventions')}</dt><dd>{metrics.recordedHumanInterventions}</dd>
        <dt>{t('botWork.metricRecovery')}</dt><dd>{percent(metrics.recoveryRate)} ({metrics.recovered}/{metrics.recoveryCandidates})</dd>
        <dt>{t('botWork.metricCost')}</dt><dd>{metrics.costPerAcceptedDeliveryUsd === null ? missing : `$${metrics.costPerAcceptedDeliveryUsd.toFixed(4)}`}</dd>
      </dl>
      <p>{t('botWork.metricsDefinition', { tasks: metrics.tasks, reviewed: metrics.reviewed, costs: metrics.knownCostDeliveries, accepted: metrics.accepted })}</p>
      <p>{t('botWork.metricsBillingHint')}</p>
    </>}
  </details>;
}

'use client';

import { useEffect, useState } from 'react';
import type { MagpieCacheModel, MagpieCacheSummary, MagpieCacheWindow } from '@ppeng/api-types';
import { useI18n, type MessageKey } from '@/lib/i18n';

const statusKeys: Record<MagpieCacheModel['status'], MessageKey> = {
  healthy: 'ops.cache.healthy', watching: 'ops.cache.watching',
  degraded: 'ops.cache.degraded', insufficient: 'ops.cache.insufficient'
};

function ObservedTime({ value }: { value: string | null }) {
  const { t, locale } = useI18n();
  if (!value) return <>{t('ops.cache.never')}</>;
  return <time dateTime={value}>{new Date(value).toLocaleString(locale)}</time>;
}

function WindowRow({ label, stats }: { label: string; stats: MagpieCacheWindow | null }) {
  const { t, locale } = useI18n();
  if (!stats) return <tr><th scope="row">{label}</th><td colSpan={3}>{t('ops.cache.noWindow')}</td></tr>;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
  const rate = (v: number | null) => v === null ? t('ops.cache.noWindow') : percent.format(v);
  return <tr>
    <th scope="row">{label}</th>
    <td>{rate(stats.ratio)}<small>{stats.cached.toLocaleString(locale)} / {stats.input.toLocaleString(locale)}</small></td>
    <td>{rate(stats.requestHitRatio)}<small>{stats.hitRequests.toLocaleString(locale)} / {stats.requests.toLocaleString(locale)}</small></td>
    <td><ObservedTime value={stats.from} /><br/><ObservedTime value={stats.to} /></td>
  </tr>;
}

function ModelResult({ model, stale }: { model: MagpieCacheModel; stale: boolean }) {
  const { t } = useI18n();
  return <li>
    <h4>{model.provider} · {model.model}</h4>
    <p>{t(statusKeys[model.status])}{model.incidentOpen && model.status !== 'degraded' && <> · {t('ops.cache.degraded')}</>}</p>
    <p className="small muted">{t('ops.cache.lastValid')} <ObservedTime value={model.lastValidAt} /></p>
    <div className="ops-cache__table"><table>
      <thead><tr><th>{t('ops.cache.window')}</th><th>{t('ops.cache.tokenRatio')}</th><th>{t('ops.cache.hitRatio')}</th><th>{t('ops.cache.period')}</th></tr></thead>
      <tbody><WindowRow label={t(stale ? 'ops.cache.lastWindow' : 'ops.cache.current')} stats={model.window}/><WindowRow label={t('ops.cache.reference')} stats={model.reference}/></tbody>
    </table></div>
  </li>;
}

type CacheResult = MagpieCacheSummary | 'empty' | 'failed' | null;

async function loadSummary(signal: AbortSignal): Promise<CacheResult> {
  const res = await fetch('/api/ops/magpie-cache', { signal, cache: 'no-store' });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return 'failed';
  const body: { summary: MagpieCacheSummary | null } = await res.json();
  return body.summary ?? 'empty';
}

const maxCheckAgeMs = 90 * 60_000;

function Results({ summary }: { summary: MagpieCacheSummary }) {
  const { t } = useI18n();
  const stale = Date.now() - Date.parse(summary.checkedAt) > maxCheckAgeMs;
  return <>
    {stale && <p role="status" className="ops-tag ops-tag--warn">{t('ops.cache.stale')}</p>}
    <p>{t('ops.cache.checked')} <ObservedTime value={summary.checkedAt} /></p>
    <p>{t('ops.cache.lastValid')} <ObservedTime value={summary.lastValidAt} /></p>
    {summary.sourceStatus === 'unavailable' && <p>{t('ops.cache.unavailable')}</p>}
    {summary.sourceStatus === 'incomplete' && <p>{t('ops.cache.incomplete')}</p>}
    {summary.models.length === 0 && <p>{t('ops.cache.insufficient')}</p>}
    <ul className="ops-cache__models">{summary.models.map(model => <ModelResult key={JSON.stringify([model.provider,model.model])} model={model} stale={stale}/>)}</ul>
  </>;
}

export function MagpieCacheHealth({ updatedAt }: { updatedAt: number | null }) {
  const { t } = useI18n();
  const [result, setResult] = useState<CacheResult>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(() => { if (!controller.signal.aborted) setResult('failed'); });
    return () => controller.abort();
  }, [updatedAt]);
  if (!result) return null;
  return <section className="card ops-cache" data-testid="magpie-cache-health">
    <div className="card-head"><h3>{t('ops.cache.title')}</h3></div>
    {typeof result === 'string'
      ? <p>{t(result === 'empty' ? 'ops.cache.empty' : 'ops.cache.unavailable')}</p>
      : <Results summary={result}/>}
  </section>;
}

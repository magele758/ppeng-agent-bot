'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

type Suppression = { id: string; memory: {key: string; value: string}; blockedCount: number };
export function MemorySuppressions({ agentId, revision, onRestore }: {agentId?: string; revision?: unknown; onRestore: () => void | Promise<void>}) {
  const { t } = useI18n();
  const [data, setData] = useState<{owner?: string; rows: Suppression[]}>({ rows: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api(`/api/memory/suppressions${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`, {signal: controller.signal})
      .then(raw => { if (!controller.signal.aborted) setData({owner: agentId, rows: (raw as {suppressions: Suppression[]}).suppressions}); })
      .catch(e => {if (!controller.signal.aborted) setError(String(e));});
    return () => controller.abort();
  }, [agentId, revision, reload]);
  return <section data-testid="memory-suppressions">
    <h3>{t('memory.suppressionTitle')}</h3>
    <p>{t('memory.suppressionHint')}</p>
    {error && <p role="alert">{error}</p>}
    {(data.owner === agentId ? data.rows : []).map(row => <article key={row.id}>
      <strong>{row.memory.key}</strong><p>{row.memory.value}</p>
      <p>{t('memory.suppressionReason', {count: row.blockedCount})}</p>
      <button disabled={busy} onClick={() => {
        setBusy(true);setError('');
        void api(`/api/memory/suppressions/${encodeURIComponent(row.id)}/restore`, {method: 'POST'})
          .then(async () => {setReload(n => n+1);await onRestore();})
          .catch(e => setError(String(e))).finally(() => setBusy(false));
      }}>{t('memory.rememberAgain')}</button>
    </article>)}
  </section>;
}

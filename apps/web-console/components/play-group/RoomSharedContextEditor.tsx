'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

import { factEditorState, type SharedFact as Fact } from '@/lib/functional-group-view';

/** Only the explicitly entered facts are shared; no private transcript is imported. */
export function RoomSharedContextEditor({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Fact[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const path = `/api/bot-shared-context?scope=room&id=${encodeURIComponent(roomId)}`;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setLoaded(false); setError(''); setSaved(false);
    void api(path).then((data) => {
      if (!alive) return;
      const entries = (data as { entries: Record<string, string> }).entries;
      setRows(Object.entries(entries).map(([key, value]) => ({ key, value })));
      setLoaded(true);
    }).catch(() => { if (alive) setError(t('play.group.sharedLoadFailed')); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, path, retry, t]);

  const edit = (next: Fact[]) => { setRows(next); setSaved(false); };
  const controls = factEditorState(rows, busy, loaded);
  const save = async () => {
    if (controls.saveDisabled) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const entries = Object.fromEntries(rows.map(row => [row.key.trim(), row.value]));
      await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
      setSaved(true);
    } catch { setError(t('play.group.sharedSaveFailed')); }
    finally { setBusy(false); }
  };

  return <details className="room-shared-context" data-testid="room-shared-context" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('play.group.sharedTitle')}</summary>
    <p className="play-group-hint">{t('play.group.sharedHint')}</p>
    {loaded ? <>
      {rows.map((row, index) => <div className="room-shared-context__fact" key={index}>
        <input data-testid="room-shared-key" aria-label={t('play.group.sharedKey', { index: index + 1 })} value={row.key} disabled={busy} onChange={event => edit(rows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} />
        <input data-testid="room-shared-value" aria-label={t('play.group.sharedValue', { index: index + 1 })} value={row.value} disabled={busy} onChange={event => edit(rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={t('play.group.sharedRemove', { index: index + 1 })} onClick={() => edit(rows.filter((_, i) => i !== index))}>×</button>
      </div>)}
      <div className="room-shared-context__actions">
        <button type="button" className="btn btn-ghost btn-sm" data-testid="room-shared-add" disabled={busy} onClick={() => edit([...rows, { key: '', value: '' }])}>{t('play.group.sharedAdd')}</button>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="room-shared-save" disabled={controls.saveDisabled} onClick={() => void save()}>{t('play.group.sharedSave')}</button>
      </div>
    </> : null}
    <RoomFactError error={error} loaded={loaded} busy={busy} retry={() => setRetry(value => value + 1)} />
    {saved ? <p role="status" className="play-group-hint">{t('play.group.sharedSaved')}</p> : null}
  </details>;
}

function RoomFactError({ error, loaded, busy, retry }: { error: string; loaded: boolean; busy: boolean; retry: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  return <p role="alert" className="play-group-error">{error} {!loaded ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={retry}>{t('play.group.sharedRetry')}</button> : null}</p>;
}

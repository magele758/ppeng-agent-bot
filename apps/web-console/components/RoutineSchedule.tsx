'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';

export type ScheduleJob = { id: string; scheduleKind?: string; scheduleValue?: string; timezone?: string; enabled: boolean; nextRunAt?: string };
export function RoutineSchedule({ job, onSaved }: { job: ScheduleJob; onSaved: (job: ScheduleJob) => void }) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState(job.scheduleValue ?? '');
  const [timezone, setTimezone] = useState(job.timezone ?? 'UTC');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const types: Record<string, MessageKey> = { once_at: 'polish.once', every_ms: 'polish.interval', cron5: 'polish.cron', event: 'polish.event' };
  const rule = job.scheduleKind === 'once_at' && job.scheduleValue && Number.isFinite(Date.parse(job.scheduleValue))
    ? new Date(job.scheduleValue).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { timeZone: (() => { try { new Intl.DateTimeFormat('en', { timeZone: job.timezone ?? 'UTC' }); return job.timezone ?? 'UTC'; } catch { return 'UTC'; } })() })
    : job.scheduleKind === 'every_ms' ? t('polish.seconds', { count: Number(job.scheduleValue) / 1000 }) : job.scheduleValue;
  return <div className="routine-schedule">
    <p>{t(types[job.scheduleKind ?? ''] ?? 'polish.unknown')} · <code>{rule}</code> · {job.timezone ?? 'UTC'}</p>
    {job.scheduleKind === 'cron5' && !editing && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setCron(job.scheduleValue ?? ''); setTimezone(job.timezone ?? 'UTC'); setError(false); setEditing(true); }}>{t('polish.editSchedule')}</button>}
    {editing && <form className="schedule-editor" onSubmit={async event => {
      event.preventDefault(); setError(false);
      if (cron.trim().split(/\s+/).length !== 5) { setError(true); return; }
      setBusy(true);
      try {
        const result = await api(`/api/cron/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: cron.trim(), timezone: timezone.trim() }) }) as { job: ScheduleJob };
        if (!result.job || result.job.id !== job.id) throw new Error('invalid_response');
        onSaved(result.job); setEditing(false);
      } catch { setError(true); } finally { setBusy(false); }
    }}>
      <label>{t('polish.expression')}<input required value={cron} disabled={busy} onChange={e => setCron(e.target.value)} /></label>
      <label>{t('polish.timezone')}<input required value={timezone} disabled={busy} onChange={e => setTimezone(e.target.value)} /></label>
      {error && <p role="alert">{t('polish.scheduleError')}</p>}
      <div><button className="btn" disabled={busy}>{t('polish.saveSchedule')}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>{t('common.cancel')}</button></div>
    </form>}
  </div>;
}

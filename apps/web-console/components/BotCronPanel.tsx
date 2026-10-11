'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  cronFromTime,
  describeCron,
  formatTimeValue,
  parseTimeValue,
  routinePrecheckPayload,
  type CronJobInfo,
  type CronPreset
} from '@/lib/cron';

const WEEKDAYS: Array<{ value: number; labelKey: MessageKey }> = [
  { value: 1, labelKey: 'play.cronPanel.mon' },
  { value: 2, labelKey: 'play.cronPanel.tue' },
  { value: 3, labelKey: 'play.cronPanel.wed' },
  { value: 4, labelKey: 'play.cronPanel.thu' },
  { value: 5, labelKey: 'play.cronPanel.fri' },
  { value: 6, labelKey: 'play.cronPanel.sat' },
  { value: 0, labelKey: 'play.cronPanel.sun' }
];

function precheckSummary(job: CronJobInfo, t: (key: MessageKey) => string): string | null {
  const raw = job.metadata?.precheck;
  if (!raw || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  const source = typeof (raw as { source?: unknown }).source === 'string' ? (raw as { source: string }).source : '';
  if (kind !== 'script' && kind !== 'predicate') return null;
  const label = kind === 'script' ? t('play.cronPanel.precheckScript') : t('play.cronPanel.precheckPredicate');
  const preview = source.length > 80 ? `${source.slice(0, 80)}…` : source;
  return preview ? `${label}: ${preview}` : label;
}

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function BotCronPanel({
  botId,
  botName
}: {
  botId: string | null;
  botName?: string;
}) {
  const [jobs, setJobs] = useState<CronJobInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState<CronPreset>('daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);
  const [cronDraft, setCronDraft] = useState('0 9 * * *');
  const [precheckKind, setPrecheckKind] = useState<'none' | 'script' | 'predicate'>('none');
  const [precheckSource, setPrecheckSource] = useState('');
  const { t } = useI18n();

  const generatedCron = useMemo(() => {
    if (preset === 'custom') return cronDraft.trim();
    const { hour, minute } = parseTimeValue(time);
    return cronFromTime({ hour, minute, preset, weekday });
  }, [preset, time, weekday, cronDraft]);

  useEffect(() => {
    if (preset === 'custom') return;
    setCronDraft(generatedCron);
  }, [generatedCron, preset]);

  const load = useCallback(async () => {
    if (!botId) {
      setJobs([]);
      return;
    }
    setErr(null);
    try {
      const data = (await api(`/api/cron/jobs?botId=${encodeURIComponent(botId)}`)) as {
        jobs?: CronJobInfo[];
      };
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createJob = async () => {
    if (!botId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const precheck = routinePrecheckPayload(precheckKind, precheckSource);
      await api('/api/cron/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botId,
          name: name.trim(),
          prompt: prompt.trim(),
          cron: generatedCron,
          ...(precheck ? { precheck } : {})
        })
      });
      setName('');
      setPrompt('');
      setPrecheckKind('none');
      setPrecheckSource('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const patchJob = async (id: string, patch: Partial<Pick<CronJobInfo, 'enabled'>>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!botId) {
    return (
      <div className="activity-panel" aria-label={t('play.cronPanel.aria')}>
        <div className="activity-panel__head">
          <h3 className="activity-panel__title">{t('play.cronPanel.title')}</h3>
        </div>
        <div className="empty-hint">{t('play.cronPanel.pickBot')}</div>
      </div>
    );
  }

  return (
    <div className="activity-panel bot-cron-panel" aria-label={t('play.cronPanel.aria')}>
      <div className="activity-panel__head">
        <h3 className="activity-panel__title">{t('play.cronPanel.title')}</h3>
        <span className="badge">{jobs.length}</span>
      </div>
      <p className="bot-cron-panel__hint">
        {t('play.cronPanel.bound', { name: botName ?? botId })}
      </p>

      <form
        className="bot-cron-form"
        onSubmit={(e) => {
          e.preventDefault();
          void createJob();
        }}
      >
        <label className="field field--stack">
          <span>{t('play.name')}</span>
          <input
            className="input-compact"
            required
            autoComplete="off"
            placeholder={t('play.cronPanel.namePh')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field field--stack">
          <span>{t('play.cronPanel.prompt')}</span>
          <textarea
            className="input-compact bot-cron-form__prompt"
            required
            rows={3}
            placeholder={t('play.cronPanel.promptPh')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="field field--stack">
          <span>{t('play.cronPanel.period')}</span>
          <select
            className="input-compact"
            value={preset}
            onChange={(e) => setPreset(e.target.value as CronPreset)}
          >
            <option value="daily">{t('play.cronPanel.daily')}</option>
            <option value="weekdays">{t('play.cronPanel.weekdays')}</option>
            <option value="weekly">{t('play.cronPanel.weekly')}</option>
            <option value="hourly">{t('play.cronPanel.hourly')}</option>
            <option value="custom">{t('play.cronPanel.custom')}</option>
          </select>
        </label>
        {preset === 'weekly' ? (
          <label className="field field--stack">
            <span>{t('play.cronPanel.weekday')}</span>
            <select
              className="input-compact"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  {t(d.labelKey)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {preset !== 'custom' ? (
          <label className="field field--stack">
            <span>{preset === 'hourly' ? t('play.cronPanel.minute') : t('play.cronPanel.time')}</span>
            {preset === 'hourly' ? (
              <input
                className="input-compact"
                type="number"
                min={0}
                max={59}
                value={parseTimeValue(time).minute}
                onChange={(e) =>
                  setTime(formatTimeValue(parseTimeValue(time).hour, Number(e.target.value)))
                }
              />
            ) : (
              <input
                className="input-compact"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value || '09:00')}
              />
            )}
          </label>
        ) : null}
        <label className="field field--stack">
          <span>Cron</span>
          <input
            className="input-compact"
            value={generatedCron}
            readOnly={preset !== 'custom'}
            onChange={(e) => setCronDraft(e.target.value)}
            aria-label={t('play.cronPanel.cronAria')}
            spellCheck={false}
          />
        </label>
        <label className="field field--stack">
          <span>{t('play.cronPanel.precheck')}</span>
          <select
            className="input-compact"
            value={precheckKind}
            onChange={(e) => setPrecheckKind(e.target.value as 'none' | 'script' | 'predicate')}
          >
            <option value="none">{t('play.cronPanel.precheckNone')}</option>
            <option value="script">{t('play.cronPanel.precheckScript')}</option>
            <option value="predicate">{t('play.cronPanel.precheckPredicate')}</option>
          </select>
        </label>
        {precheckKind !== 'none' ? (
          <label className="field field--stack">
            <span>{precheckKind === 'script' ? t('play.cronPanel.precheckScript') : t('play.cronPanel.precheckPredicate')}</span>
            <textarea
              className="input-compact bot-cron-form__prompt"
              required
              rows={2}
              placeholder={t('play.cronPanel.precheckPh')}
              value={precheckSource}
              onChange={(e) => setPrecheckSource(e.target.value)}
            />
          </label>
        ) : null}
        {precheckKind !== 'none' ? <p className="bot-cron-form__preview">{t('play.cronPanel.precheckHint')}</p> : null}
        <p className="bot-cron-form__preview">{describeCron(generatedCron)}</p>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {t('play.cronPanel.add')}
        </button>
      </form>

      {err ? <p className="bot-cron-panel__err">{err}</p> : null}

      <div className="activity-panel__list">
        {!jobs.length ? (
          <div className="empty-hint">{t('play.cronPanel.empty')}</div>
        ) : (
          jobs.map((job) => {
            const summary = precheckSummary(job, t);
            return (
            <article key={job.id} className={`activity-card${job.enabled ? '' : ' is-off'}`}>
              <div className="bot-cron-card__head">
                <strong>{job.name}</strong>
                <span className="bot-cron-card__when">
                  {describeCron(job.scheduleValue)}
                </span>
              </div>
              <p className="bot-cron-card__prompt">{job.prompt}</p>
              {summary ? <p className="bot-cron-card__meta">{summary}</p> : null}
              <p className="bot-cron-card__meta">
                {t('play.cronPanel.next', { when: formatWhen(job.nextRunAt) })}
                {job.lastRunAt ? t('play.cronPanel.last', { when: formatWhen(job.lastRunAt) }) : ''}
              </p>
              <div className="bot-cron-card__actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void patchJob(job.id, { enabled: !job.enabled })}
                >
                  {job.enabled ? t('play.cronPanel.pause') : t('play.cronPanel.enable')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => void removeJob(job.id)}
                >
                  {t('play.cronPanel.remove')}
                </button>
              </div>
            </article>
            );
          })
        )}
      </div>
    </div>
  );
}

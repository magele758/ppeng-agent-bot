'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import './correction-capture.css';
const lines = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);
async function action(sid: string, body: Record<string, unknown>) { return api(`/api/sessions/${sid}/learning`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
export function CorrectionCapture({ sessionId, messageId }: {
    sessionId: string;
    messageId: string;
}) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
    const [draft, setDraft] = useState({ expected: '', forbiddenText: '', forbiddenTools: '', prompt: '', kind: 'regression' });
    if (!open)
        return <button type="button" className="correction-capture__trigger btn btn-ghost btn-icon btn-sm" aria-label={t('learning.capture')} onClick={() => setOpen(true)}><svg className="correction-capture__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12.7 1.3a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L6.2 12.8 3 13.2l.4-3.2 9.3-8.7zM4.2 10.6l-.2 1.4 1.4-.2 7.2-7.2-1.2-1.2-7.2 7.2z" /></svg></button>;
    return <details open><summary onClick={e => { e.preventDefault(); setOpen(false); }}>{t('learning.capture')}</summary><p>{t('learning.captureHint')}</p>
 {(['expected', 'forbiddenText', 'forbiddenTools', 'prompt'] as const).map(key => <label className="field field--stack" key={key}>{t(`learning.${key}`)}<textarea value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/></label>)}
 <select aria-label={t('learning.kind')} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}><option value="regression">{t('learning.regression')}</option><option value="counterexample">{t('learning.counterexample')}</option></select>
 <button disabled={busy} onClick={() => { setBusy(true); void action(sessionId, { action: 'capture', messageId, ...draft, prompt: draft.prompt || undefined, expected: lines(draft.expected), forbiddenText: lines(draft.forbiddenText), forbiddenTools: lines(draft.forbiddenTools) }).then(() => setStatus(t('learning.saved'))).catch(e => setStatus(String(e))).finally(() => setBusy(false)); }}>{t('learning.save')}</button><p role="status">{status}</p></details>;
}
type Report = {
    id: string;
    passed: boolean;
    durationMs: number;
    inputTokens: number | null;
    failures: string[];
    output: string;
};
type Data = {
    cases: {
        id: string;
        kind: string;
        expected: string[];
    }[];
    reports: Report[];
    candidates: {
        id: string;
        name: string;
        passed: boolean;
        baseline: Report[];
        candidate: Report[];
        publishedVersion?: string;
    }[];
    versions: {
        id: string;
        name: string;
        createdAt: string;
        currentDigest: string;
    }[];
    sources: {
        kind: string;
        ref: string;
        label: string;
    }[];
    scope: {
        allowedEffects: string[];
    };
    queue: {
        id: string;
        text: string;
        source: string;
        decision: string;
        reason: string;
        mergedInto: string | null;
    }[];
    queueSettings: {
        batchSize: number;
        agingSeconds: number;
    };
};
export function LearningWorkbench({ sessionId }: {
    sessionId: string;
}) {
    const { t } = useI18n();
    const [data, setData] = useState<Data>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState<string[]>([]);
    const [draft, setDraft] = useState({ name: '', description: '', body: '' }), [scope, setScope] = useState(''), [queue, setQueue] = useState({ batchSize: 32, agingSeconds: 60 });
    async function refresh() { const d = await api(`/api/sessions/${sessionId}/learning`) as Data; setData(d); setScope(d.scope.allowedEffects.join('\n')); setQueue(d.queueSettings); }
    useEffect(() => { let active = true; void api(`/api/sessions/${sessionId}/learning`).then(value => { if (active) {
        const d = value as Data;
        setData(d);
        setScope(d.scope.allowedEffects.join('\n'));
        setQueue(d.queueSettings);
    } }).catch(e => { if (active)
        setError(String(e)); }); return () => { active = false; }; }, [sessionId]);
    async function run(body: Record<string, unknown>) { setBusy(true); setError(''); try {
        await action(sessionId, body);
        await refresh();
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setBusy(false);
    } }
    const score = (reports: Report[]) => `${reports.filter(r => r.passed).length}/${reports.length} · ${reports.reduce((n, r) => n + r.durationMs, 0)} ms · ${reports.every(r => r.inputTokens !== null) ? reports.reduce((n, r) => n + (r.inputTokens ?? 0), 0) : t('learning.unknown')}`;
    return <details><summary>{t('learning.title')}</summary><p>{t('learning.hint')}</p>{error && <p role="alert">{error}</p>}
 <button disabled={busy} onClick={() => void refresh().catch(e => setError(String(e)))}>{t('learning.refresh')}</button>
 <fieldset disabled={busy || !data}><legend>{t('learning.cases')}</legend>
 {data?.cases.map(c => <div key={c.id}><label className="field"><input type="checkbox" checked={selected.includes(c.id)} onChange={e => setSelected(e.target.checked ? [...selected, c.id] : selected.filter(id => id !== c.id))}/>{c.id} · {c.kind === 'counterexample' ? t('learning.counterexample') : t('learning.regression')} · {c.expected.join(', ')}<button onClick={() => void run({ action: 'replay', id: c.id, skill: draft.body })}>{t('learning.replay')}</button></label><details><summary>{t('learning.evidence')}</summary><pre>{JSON.stringify(c,null,2)}</pre></details></div>)}
 {(['name', 'description', 'body'] as const).map(key => <label className="field field--stack" key={key}>{t(`learning.${key}`)}<textarea value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/></label>)}
 <button onClick={() => void run({ action: 'validate', ...draft, caseIds: selected })}>{t('learning.validate')}</button>
 {data?.candidates.map(c => <div key={c.id}><p>{c.name} · {t('learning.baseline')}: {score(c.baseline)} → {t('learning.candidate')}: {score(c.candidate)}</p><button disabled={!c.passed || !!c.publishedVersion} onClick={() => void run({ action: 'publish', id: c.id })}>{c.publishedVersion ? t('learning.published') : t('learning.publish')}</button></div>)}
 <h4>{t('learning.versions')}</h4>{data?.versions.map(v => <p key={v.id}>{v.name} · {v.createdAt} <button onClick={() => void run({ action: 'rollback', id: v.id, expectedDigest: v.currentDigest })}>{t('learning.rollback')}</button></p>)}
 <h4>{t('learning.reports')}</h4>{data?.reports.slice(0, 12).map(r => <details key={r.id}><summary>{r.passed ? t('learning.pass') : t('learning.fail')} · {r.durationMs} ms</summary><pre>{r.failures.join('\n')}\n{r.output}</pre></details>)}
 <h4>{t('learning.sources')}</h4><ul>{data?.sources.map((s, i) => <li key={i}>{s.kind} · {s.label} · {s.ref}</li>)}</ul>
 <label className="field field--stack">{t('learning.scope')}<textarea value={scope} onChange={e => setScope(e.target.value)}/></label><p>{t('learning.scopeHint')}</p><button onClick={() => void run({ action: 'scope', allowedEffects: lines(scope) })}>{t('learning.save')}</button>
 <h4>{t('learning.queue')}</h4>{(['batchSize', 'agingSeconds'] as const).map(key => <label className="field" key={key}>{t(`learning.${key}`)}<input type="number" min="1" max={key === 'batchSize' ? 100 : 3600} value={queue[key]} onChange={e => setQueue({ ...queue, [key]: Number(e.target.value) })}/></label>)}<button onClick={() => void run({ action: 'queue', ...queue })}>{t('learning.save')}</button>
 <ul>{data?.queue.map(q => <li key={q.id}>{q.source} · {q.decision === 'coalesced' ? t('learning.coalesced') : q.decision === 'applied' ? t('learning.applied') : t('learning.pending')} · {q.reason === 'direct_input' ? t('learning.direct') : t('learning.aging')} {q.mergedInto} <details><summary>{t('learning.evidence')}</summary>{q.text}</details></li>)}</ul>
 </fieldset></details>;
}

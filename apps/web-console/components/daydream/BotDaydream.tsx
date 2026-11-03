'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { Knowledge, Run, SettingsResponse } from './types';
import { DaydreamSettingsForm } from './DaydreamSettings';
import { DaydreamKnowledge, DaydreamRuns } from './DaydreamRecords';
import styles from './Daydream.module.css';
function actionMessage(path: string): MessageKey { if (path === '/runs')
    return 'daydream.started'; if (path === '/knowledge/govern')
    return 'daydream.governed'; return 'daydream.decided'; }
export function BotDaydreamTab({ panelId, selected, onSelect }: {
    panelId: string;
    selected: string;
    onSelect: (tab: string) => void;
}) { const { t } = useI18n(); return <button type="button" role="tab" id={`${panelId}-tab-daydream`} aria-controls={`${panelId}-page-daydream`} aria-selected={selected === 'daydream'} onClick={() => onSelect('daydream')}>{t('daydream.title')}</button>; }
export function BotDaydreamPage({ botId, panelId, selected }: {
    botId: string;
    panelId: string;
    selected: string;
}) { if (selected !== 'daydream')
    return null; return <div role="tabpanel" id={`${panelId}-page-daydream`} aria-labelledby={`${panelId}-tab-daydream`}><BotDaydream key={botId} botId={botId}/></div>; }
function BotDaydream({ botId }: {
    botId: string;
}) {
    const { t } = useI18n();
    const endpoint = `/api/bots/${encodeURIComponent(botId)}/daydream`;
    const [data, setData] = useState<SettingsResponse>();
    const [runs, setRuns] = useState<Run[]>([]);
    const [knowledge, setKnowledge] = useState<Knowledge>({ canGovern: false, submissions: [], artifacts: [] });
    const [date, setDate] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const alive = useRef(true);
    const loadRecords = useCallback(async () => { const [result, shared] = await Promise.all([api(`${endpoint}/runs`), api(`${endpoint}/knowledge`)]); if (!alive.current)
        return; setRuns((result as {
        runs: Run[];
    }).runs); setKnowledge(shared as Knowledge); }, [endpoint]);
    useEffect(() => { alive.current = true; void Promise.all([api(`${endpoint}/settings`), loadRecords()]).then(([value]) => { if (alive.current)
        setData(value as SettingsResponse); }).catch(e => { if (alive.current)
        setError(String(e)); }); return () => { alive.current = false; }; }, [endpoint, loadRecords]);
    useEffect(() => {
        let pending = false;
        const timer = setInterval(() => {
            if (pending) return;
            pending = true;
            void loadRecords().catch(() => {}).finally(() => { pending = false; });
        }, 3000);
        return () => clearInterval(timer);
    }, [loadRecords]);
    const perform = async (work: () => Promise<unknown>, success: string) => { setBusy(true); setError(''); setMessage(''); try {
        await work();
        if (alive.current)
            setMessage(success);
    }
    catch (e) {
        if (alive.current)
            setError(String(e));
    }
    finally {
        if (alive.current)
            setBusy(false);
    } };
    const save = () => void perform(async () => { const saved = await api(`${endpoint}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); if (alive.current)
        setData(saved as SettingsResponse); }, t('daydream.saved'));
    const act = (path: string, body: unknown) => void perform(async () => { await api(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await loadRecords(); }, t(actionMessage(path)));
    return <section className={styles.panel} data-testid="bot-daydream"><h3>{t('daydream.title')}</h3>{error && <p role="alert" className={styles.error}>{t('daydream.failed', { error })}</p>}{message && <p role="status">{message}</p>}{data ? <DaydreamSettingsForm data={data} onChange={setData} busy={busy} onSave={save}/> : <p>{t('daydream.loading')}</p>}
 <div className={styles.actions}><label className={styles.field}>{t('daydream.date')}<input type="date" value={date} onChange={e => setDate(e.target.value)}/></label><button type="button" disabled={busy} onClick={() => act('/runs', date ? { date } : {})}>{t('daydream.run')}</button><button type="button" disabled={busy} onClick={() => void perform(loadRecords, '')}>{t('daydream.refresh')}</button></div><DaydreamRuns runs={runs} busy={busy} act={act}/><DaydreamKnowledge knowledge={knowledge} busy={busy} act={act}/></section>;
}

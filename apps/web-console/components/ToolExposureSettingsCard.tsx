'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { SettingsGroup } from './ui';
type Item = {
    name: string;
    group: string;
    tier: number;
    state: string;
    reason: string;
};
type View = {
    mode: string;
    items: Item[];
    counts: Record<string, number>;
};
type Config = View & {
    settings: {
        mode: string;
        pinnedGroups: Record<string, string[]>;
    };
    groups: {
        id: string;
        tier: number;
        labelZh: string;
        labelEn: string;
    }[];
    agents: {
        id: string;
        name: string;
    }[];
};
export function ToolExposureSettingsCard({ sessionId }: {
    sessionId?: string;
}) {
    const { t, locale } = useI18n();
    const label = (key: string) => t(`settingsEntries.toolExposure.${key}` as MessageKey);
    const [data, setData] = useState<Config>();
    const [view, setView] = useState<View>();
    const [agent, setAgent] = useState('general');
    const [sessions, setSessions] = useState<{
        id: string;
        title: string;
        agentId: string;
    }[]>([]);
    const [sid, setSid] = useState(sessionId ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const [saved, setSaved] = useState(false);
    const version = useRef(0);
    const reload = useCallback(async () => { const current = ++version.current; try {
        const cfg = await api(`/api/tool-exposure/settings?agentId=${encodeURIComponent(agent)}`) as Config;
        const v = sid ? await api(`/api/sessions/${encodeURIComponent(sid)}/tool-exposure`) as View : cfg;
        if (current === version.current) {
            setData(cfg);
            setView(v);
            setError(false);
        }
    }
    catch {
        if (current === version.current)
            setError(true);
    } }, [agent, sid]);
    useEffect(() => { void reload(); return () => { version.current++; }; }, [reload]);
    useEffect(() => { void api('/api/sessions').then(d => setSessions((d as {
        sessions: typeof sessions;
    }).sessions)).catch(() => setError(true)); }, []);
    const save = async (patch: Record<string, unknown>) => { setBusy(true); setSaved(false); try {
        await api('/api/tool-exposure/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        await reload();
        setSaved(true);
    }
    catch {
        setError(true);
    }
    finally {
        setBusy(false);
    } };
    const clear = async () => { setBusy(true); try {
        await api(`/api/sessions/${encodeURIComponent(sid)}/tool-exposure`, { method: 'DELETE' });
        await reload();
        setSaved(true);
    }
    catch {
        setError(true);
    }
    finally {
        setBusy(false);
    } };
    const pins = data?.settings.pinnedGroups[agent] ?? [];
    return <div data-testid="tool-exposure-settings"><SettingsGroup title={label('title')} description={label('desc')}>
 {error ? <p role="alert">{label('error')}</p> : null}
 {data && view ? <>
 <label htmlFor="tool-delivery-mode">{label('mode')}</label><select id="tool-delivery-mode" value={data.settings.mode} disabled={busy} onChange={e => void save({ mode: e.target.value })}><option value="progressive">{label('progressive')}</option><option value="full">{label('full')}</option></select>
 <p>{label('discoveryHint')}</p>
 <label htmlFor="tool-delivery-agent">{label('agent')}</label><select id="tool-delivery-agent" value={agent} disabled={busy} onChange={e => { setAgent(e.target.value); setSid(''); }}>{data.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
 <fieldset disabled={busy}><legend>{label('pins')}</legend>{data.groups.filter(g => g.tier > 1).map(g => <label key={g.id} style={{ display: 'block' }}><input type="checkbox" checked={pins.includes(g.id)} onChange={e => void save({ agentId: agent, groups: e.target.checked ? [...pins, g.id] : pins.filter(id => id !== g.id) })}/>{locale === 'zh' ? g.labelZh : g.labelEn}</label>)}</fieldset>
 <label htmlFor="tool-delivery-session">{label('session')}</label><select id="tool-delivery-session" value={sid} disabled={busy} onChange={e => { const id = e.target.value; setSid(id); const s = sessions.find(s => s.id === id); if (s)
            setAgent(s.agentId); }}><option value="">{label('preview')}</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}</select>
 <p>{label('viewMode')}: {view.mode === 'full' ? label('full') : label('progressive')}</p>
 <div data-testid="tool-exposure-counts">{Object.entries(view.counts).map(([k, v]) => <span key={k} style={{ marginRight: 12 }}>{label(k)}: {v}</span>)}</div>
 <details><summary>{label('details')}</summary><table><thead><tr><th>{label('tool')}</th><th>{label('tier')}</th><th>{label('state')}</th></tr></thead><tbody>{view.items.map(item => <tr key={item.name}><td><code>{item.name}</code></td><td>{item.tier}</td><td>{label(item.reason === 'mode' ? 'modeReason' : item.reason)}</td></tr>)}</tbody></table></details>
 <button type="button" className="btn btn-secondary" disabled={busy || !sid} onClick={() => void clear()}>{label('clear')}</button>
 </> : null}
 <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void reload()}>{label('refresh')}</button>
 {saved ? <p role="status">{label('saved')}</p> : null}
 </SettingsGroup></div>;
}

"use client";
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
type Machine = {
    id: string;
    name: string;
    repositories: {
        id: string;
        path: string;
    }[];
};
type Profile = {
    enabled: boolean;
    allowedUserIds: string[];
    image: string;
    toolPath: string;
    model: string;
    modelUrl: string;
    credentialRef: string;
    codeArgv: string[];
    reviewArgv: string[];
    checks: {
        id: string;
        argv: string[];
        required: boolean;
    }[];
    redCheck: string;
    install: string[];
    timeoutMs: number;
    maxRounds: number;
    maxRetries: number;
    minDiskMb: number;
    maxWorkspaceMiB: number;
    criteria: {
        id: string;
        given: string;
        when: string;
        then: string;
    }[];
    criteriaApproved: boolean;
    baselineFailures: string[];
};
type Task = {
    id: string;
    machineId: string;
    status: string;
    evidenceCurrent?: boolean;
    result?: unknown;
    error?: string;
    development?: {
        stage: string;
        round: number;
        baseline?: string;
        delivery?: string;
        decisions?: unknown[];
    };
};
type Preflight = {
    ready: boolean;
    checks: {
        id: string;
        ok: boolean;
        detail?: string;
    }[];
};
const initial: Profile = { enabled: false, allowedUserIds: [], image: '', toolPath: '', model: '', modelUrl: '', credentialRef: '', codeArgv: ['/tools/claude', '--print', '--output-format', 'json', '--dangerously-skip-permissions'], reviewArgv: ['/tools/claude', '--print', '--output-format', 'json', '--dangerously-skip-permissions'], checks: [{ id: 'unit', argv: ['pnpm', 'test'], required: true }], redCheck: 'unit', install: ['pnpm', 'install', '--frozen-lockfile', '--offline'], timeoutMs: 3600000, maxRounds: 6, maxRetries: 1, minDiskMb: 2048, maxWorkspaceMiB:1024, criteria: [], criteriaApproved: false, baselineFailures: [] };
const send = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const decisionTasks = (value: unknown): Task[] => { const tasks = (value as {
    tasks?: Task[];
}).tasks; return Array.isArray(tasks) ? tasks : []; };
const taskUrl = (id: string) => `/api/factory/development/tasks/${encodeURIComponent(id)}`;
function useOperation() {
    const [busy, setBusy] = useState(false), [error, setError] = useState(false);
    const pending = useRef(false), alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const run = async (fn: () => Promise<void>) => { if (pending.current)
        return; pending.current = true; setBusy(true); setError(false); try {
        await fn();
    }
    catch {
        if (alive.current)
            setError(true);
    }
    finally {
        pending.current = false;
        if (alive.current)
            setBusy(false);
    } };
    return { busy, error, setError, run };
}
function useProfile(url: string) {
    const [profile, setProfile] = useState(initial), [loaded, setLoaded] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(false), [json, setJson] = useState({ criteria: '[]', checks: JSON.stringify(initial.checks, null, 2), install: JSON.stringify(initial.install), codeArgv: JSON.stringify(initial.codeArgv), reviewArgv: JSON.stringify(initial.reviewArgv) });
    useEffect(() => { let active = true; void api(url).then(r => { if (!active)
        return; const p = { ...initial, ...(r as {
            settings: Partial<Profile>;
        }).settings }; setProfile(p); setJson({ criteria: JSON.stringify(p.criteria, null, 2), checks: JSON.stringify(p.checks, null, 2), install: JSON.stringify(p.install), codeArgv: JSON.stringify(p.codeArgv), reviewArgv: JSON.stringify(p.reviewArgv) }); setLoaded(true); }).catch(() => { if (active)
        setError(true); }); return () => { active = false; }; }, [url]);
    const field = (key: keyof Profile, value: unknown) => { setProfile(p => ({ ...p, [key]: value })); setDirty(true); };
    const jsonField = (key: keyof typeof json, value: string) => { setJson(p => ({ ...p, [key]: value })); setDirty(true); };
    const save = async () => { const body = { ...profile, ...Object.fromEntries(Object.entries(json).map(([key, value]) => [key, JSON.parse(value)])) }; const r = await api(url, send(body, 'PATCH')) as {
        settings: Profile;
    }; setProfile(r.settings); setDirty(false); };
    return { profile, loaded, dirty, error, field, json, jsonField, save };
}
type ProfileController = ReturnType<typeof useProfile>;
function useProjectSelection(machines: Machine[]) {
    const [machine, setMachine] = useState(''), [repository, setRepository] = useState('');
    const selected = machines.find(m => m.id === machine) ?? machines[0];
    const repo = selected?.repositories.find(r => r.id === repository) ?? selected?.repositories[0];
    return { machines, selected, repo, setMachine: (value: string) => { setMachine(value); setRepository(''); }, setRepository };
}
type Selection = ReturnType<typeof useProjectSelection>;
function ProjectSelection({ selection: s, reassign = false }: {
    selection: Selection;
    reassign?: boolean;
}) { const { t } = useI18n(); return <><label>{t(reassign ? 'factory.devReassignMachine' : 'factory.machine')}<select data-testid={reassign ? 'development-reassign-machine' : 'development-machine'} value={s.selected?.id ?? ''} onChange={e => s.setMachine(e.target.value)}>{s.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>{t('factory.repoId')}<select value={s.repo?.id ?? ''} onChange={e => s.setRepository(e.target.value)}>{s.selected?.repositories.map(r => <option key={r.id} value={r.id}>{r.id}</option>)}</select></label></>; }
export function FactoryDevelopment({ machines, refresh }: {
    machines: Machine[];
    refresh: () => Promise<void>;
}) {
    const { t } = useI18n(), selection = useProjectSelection(machines);
    const { selected, repo } = selection;
    return <section data-testid="factory-development" className="ag-panel"><h4>{t('factory.developmentTitle')}</h4><p>{t('factory.developmentHint')}</p><ProjectSelection selection={selection}/>
 {selected && repo ? <DevelopmentProject key={`${selected.id}/${repo.id}`} machine={selected.id} repository={repo.id} refresh={refresh}/> : <p>{t('factory.devChooseProject')}</p>}
 <DevelopmentDecisions machines={machines}/></section>;
}
function DevelopmentProject({ machine, repository, refresh }: {
    machine: string;
    repository: string;
    refresh: () => Promise<void>;
}) {
    const { t } = useI18n();
    const url = `/api/factory/development/${encodeURIComponent(machine)}/${encodeURIComponent(repository)}`, config = useProfile(url), op = useOperation();
    const [baseline, setBaseline] = useState(''), [requirement, setRequirement] = useState(''), [preflight, setPreflight] = useState<Preflight | null>(null), [task, setTask] = useState<Task | null>(null), [saved, setSaved] = useState(false);
    const request = useRef({ fingerprint: '', key: '' });
    const validBaseline = /^[a-f0-9]{40}$/.test(baseline);
    const requirements = [!op.busy, config.loaded, !config.dirty, config.profile.enabled, validBaseline];
    const canCheck = requirements.every(Boolean), canSubmit = [...requirements, requirement.trim(), preflight?.ready].every(Boolean);
    useEffect(() => { setPreflight(null); }, [baseline, config.dirty]);
    const submit = async () => { const fingerprint = JSON.stringify({ machine, repository, baseline, requirement, profile: config.profile }); if (request.current.fingerprint !== fingerprint)
        request.current = { fingerprint, key: crypto.randomUUID() }; const r = await api('/api/factory/development/tasks', send({ machineId: machine, repositoryId: repository, baseline, requirement, requestKey: request.current.key })) as {
        task: Task;
    }; setTask(r.task); await refresh(); };
    return <><fieldset disabled={op.busy || !config.loaded}><ProfileFields config={config}/><button data-testid="development-save" onClick={() => void op.run(async () => { await config.save(); setSaved(true); setPreflight(null); })}>{t('factory.save')}</button></fieldset>
 <label>{t('factory.devBaseline')}<input data-testid="development-baseline" value={baseline} disabled={op.busy} onChange={e => setBaseline(e.target.value)}/></label>
 <label>{t('factory.devRequirement')}<textarea data-testid="development-requirement" value={requirement} disabled={op.busy} onChange={e => setRequirement(e.target.value)}/></label>
 <button data-testid="development-preflight" disabled={!canCheck} onClick={() => void op.run(async () => { setPreflight(null); setPreflight(await api(url + '/preflight', send({ baseline })) as Preflight); })}>{t('factory.devPreflight')}</button>
 <button data-testid="development-submit" disabled={!canSubmit} onClick={() => void op.run(submit)}>{t('factory.devSubmit')}</button>
 <ProjectFeedback config={config} saved={saved} error={op.error} preflight={preflight}/>{task && <DevelopmentTask task={task} setTask={setTask}/>}</>;
}
function ProjectFeedback({ config, saved, error, preflight }: {
    config: ProfileController;
    saved: boolean;
    error: boolean;
    preflight: Preflight | null;
}) { const { t } = useI18n(); return <>{saved && !config.dirty && <p role="status">{t('factory.saved')}</p>}{preflight && <PreflightResult value={preflight}/>}<OperationError visible={error || config.error}/></>; }
function ProfileFields({ config: c }: {
    config: ProfileController;
}) {
    const { t } = useI18n();
    return <><label><input data-testid="development-enabled" type="checkbox" checked={c.profile.enabled} onChange={e => c.field('enabled', e.target.checked)}/>{t('factory.developmentEnable')}</label>
 <label>{t('factory.users')}<input value={c.profile.allowedUserIds.join(',')} onChange={e => c.field('allowedUserIds', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}/></label>
 <ProfileTextFields config={c}/><ProfileNumericFields config={c}/>
 <JsonField config={c} field="criteria" label="factory.devCriteria" rows={5}/>
 <label><input type="checkbox" checked={c.profile.criteriaApproved} onChange={e => c.field('criteriaApproved', e.target.checked)}/>{t('factory.devApproveCriteria')}</label>
 <JsonField config={c} field="checks" label="factory.devChecks" rows={5}/><label>{t('factory.devRedCheck')}<input value={c.profile.redCheck} onChange={e => c.field('redCheck', e.target.value)}/></label>
 <JsonField config={c} field="install" label="factory.devInstall"/>
 <details><summary>{t('factory.devAdvanced')}</summary><JsonField config={c} field="codeArgv" label="factory.devCodeArgv"/><JsonField config={c} field="reviewArgv" label="factory.devReviewArgv"/><label>{t('factory.devBaselineFailures')}<textarea value={c.profile.baselineFailures.join('\n')} onChange={e => c.field('baselineFailures', e.target.value.split('\n').filter(Boolean))}/></label></details></>;
}
function ProfileTextFields({ config: c }: {
    config: ProfileController;
}) { const { t } = useI18n(); return <>{(['image', 'toolPath', 'model', 'modelUrl', 'credentialRef'] as const).map(key => <label key={key}>{t(`factory.dev${key[0]!.toUpperCase() + key.slice(1)}` as MessageKey)}<input data-testid={`development-${key}`} value={c.profile[key]} onChange={e => c.field(key, e.target.value)}/></label>)}</>; }
function ProfileNumericFields({ config: c }: {
    config: ProfileController;
}) { const { t } = useI18n(); return <>{(['timeoutMs', 'maxRounds', 'maxRetries', 'minDiskMb', 'maxWorkspaceMiB'] as const).map(key => <label key={key}>{t(`factory.dev${key[0]!.toUpperCase() + key.slice(1)}` as MessageKey)}<input type="number" value={c.profile[key]} onChange={e => c.field(key, Number(e.target.value))}/></label>)}</>; }
function JsonField({ config, field, label, rows = 2 }: {
    config: ProfileController;
    field: keyof ProfileController['json'];
    label: MessageKey;
    rows?: number;
}) { const { t } = useI18n(); return <label>{t(label)}<textarea rows={rows} value={config.json[field]} onChange={e => config.jsonField(field, e.target.value)}/></label>; }
function PreflightResult({ value }: {
    value: Preflight;
}) { const { t } = useI18n(); return <div data-testid="development-preflight-result" role="status"><p>{t(value.ready ? 'factory.devReadyCheckPassed' : 'factory.devReadyCheckFailed')}</p><ul>{value.checks.map(c => <li key={c.id}>{c.id}: {t(c.ok ? 'factory.devCheckPassed' : 'factory.devCheckFailed')} {c.detail}</li>)}</ul></div>; }
function OperationError({ visible }: {
    visible: boolean;
}) { const { t } = useI18n(); return visible ? <p role="alert">{t('factory.error')}</p> : null; }
export function DevelopmentTask({ task, setTask }: {
    task: Task;
    setTask: (task: Task) => void;
}) {
    const { t } = useI18n(), op = useOperation();
    const current = async () => { const r = await api(taskUrl(task.id)) as {
        task: Task;
    }; setTask(r.task); };
    const control = async (action: string) => { const r = await api(taskUrl(task.id) + '/control', send({ action })) as {
        task: Task;
    }; setTask(r.task); };
    const active = ['queued', 'running', 'unknown'].includes(task.status);
    return <article data-testid="development-task"><TaskSummary task={task}/><button data-testid="development-task-refresh" disabled={op.busy} onClick={() => void op.run(current)}>{t('factory.refresh')}</button>
 {active && <><button disabled={op.busy} onClick={() => void op.run(() => control('pause'))}>{t('factory.devPause')}</button><button disabled={op.busy} onClick={() => void op.run(() => control('cancel'))}>{t('factory.devCancel')}</button></>}
 <TaskEvidence task={task}/><OperationError visible={op.error}/></article>;
}
function TaskSummary({ task }: {
    task: Task;
}) { const { t } = useI18n(); const stage = task.development?.stage; return <><p>{t('factory.taskId')}: {task.id} · {t('factory.machine')}: {task.machineId}</p><p>{t('factory.devStage')}: {stage} · {t('factory.devRound')}: {task.development?.round}</p><p>{t(stage === 'READY' && task.evidenceCurrent !== false ? 'factory.devLocalReady' : 'factory.devNotDelivered')}</p>{task.evidenceCurrent === false && <p role="alert">{t('factory.devStaleEvidence')}</p>}{task.error && <p>{task.error}</p>}</>; }
function TaskEvidence({ task }: {
    task: Task;
}) { const { t } = useI18n(); return <details><summary>{t('factory.devEvidence')}</summary><pre>{JSON.stringify(task, null, 2)}</pre></details>; }
function DevelopmentDecisions({ machines }: {
    machines: Machine[];
}) {
    const { t } = useI18n(), op = useOperation();
    const [tasks, setTasks] = useState<Task[]>([]);
    const version = useRef(0);
    const load = async () => { const n = ++version.current; const r = await api('/api/factory/development/decisions') as {
        tasks: Task[];
    }; if (n === version.current)
        setTasks(decisionTasks(r)); };
    useEffect(() => { let alive = true; const n = ++version.current; void api('/api/factory/development/decisions').then(r => { if (alive && n === version.current)
        setTasks(decisionTasks(r)); }).catch(() => { if (alive && n === version.current)
        op.setError(true); }); return () => { alive = false; }; }, []);
    const resolved = (task: Task) => { ++version.current; setTasks(list => list.filter(t => t.id !== task.id)); };
    return <><h4>{t('factory.devDecisions')}</h4><button data-testid="development-decisions-refresh" disabled={op.busy} onClick={() => void op.run(load)}>{t('factory.refresh')}</button><OperationError visible={op.error}/>{tasks.length === 0 && <p>{t('factory.devNoDecisions')}</p>}{tasks.map(task => <DevelopmentDecision key={task.id} task={task} machines={machines} resolved={resolved}/>)}</>;
}
function DevelopmentDecision({ task, machines, resolved }: {
    task: Task;
    machines: Machine[];
    resolved: (task: Task) => void;
}) {
    const { t } = useI18n(), op = useOperation();
    const [rounds, setRounds] = useState(1), selection = useProjectSelection(machines);
    const { selected: target, repo } = selection;
    const decide = async (body: unknown) => { const r = await api(taskUrl(task.id) + '/decision', send(body)) as {
        task: Task;
    }; resolved(r.task); };
    return <article data-testid={`development-decision-${task.id}`}><TaskSummary task={task}/><TaskEvidence task={task}/><fieldset disabled={op.busy}>
 <label>{t('factory.devAdditionalRounds')}<input type="number" min={1} max={20} value={rounds} onChange={e => setRounds(Number(e.target.value))}/></label><button onClick={() => void op.run(() => decide({ action: 'add-rounds', rounds }))}>{t('factory.devAddRounds')}</button><button onClick={() => void op.run(() => decide({ action: 'resume' }))}>{t('factory.devResume')}</button><button onClick={() => void op.run(() => decide({action:'verify-current'}))}>{t('factory.devVerifyCurrent')}</button><button onClick={() => void op.run(() => decide({ action: 'confirm-policy' }))}>{t('factory.devConfirmPolicy')}</button>
 <ProjectSelection selection={selection} reassign/><button data-testid="development-reassign" disabled={!target || !repo} onClick={() => void op.run(() => decide({ action: 'reassign', machineId: target!.id, repositoryId: repo!.id }))}>{t('factory.devReassign')}</button></fieldset><OperationError visible={op.error}/></article>;
}

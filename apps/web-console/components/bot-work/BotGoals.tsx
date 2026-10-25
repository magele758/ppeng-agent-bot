'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { goalActions, goalVerifyRequest, goalsPanelState, type BotGoalView, type BotGoalsSnapshot, type BotGoalSettings, type GoalStrategy } from '@/lib/bot-goals';
import './bot-goals.css';

export function BotGoals({ botId, sessionId, selectedGoalId, onSelectGoal, initialSnapshot = null }: {
  botId: string; sessionId: string; selectedGoalId?: string | null; onSelectGoal?: (id: string | null) => void;
  initialSnapshot?: BotGoalsSnapshot | null;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<BotGoalsSnapshot | null>(initialSnapshot);
  const [draft, setDraft] = useState<BotGoalSettings | null>(initialSnapshot?.settings ?? null);
  const [error, setError] = useState('');
  const [listFailed, setListFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const alive = useRef(true);
  const revision = useRef(0);
  const base = `/api/bots/${encodeURIComponent(botId)}/goals`;
  const load = async (signal?: AbortSignal) => {
    const generation = ++revision.current;
    try {
      const value = await api(`${base}?sessionId=${encodeURIComponent(sessionId)}`, { signal }) as BotGoalsSnapshot;
      if (!alive.current || generation !== revision.current) return;
      setSnapshot(value);
      setDraft(previous => previous ?? value.settings);
      setError('');
      setListFailed(false);
    } catch {
      if (signal?.aborted || !alive.current || generation !== revision.current) return;
      setListFailed(true);
    }
  };
  useEffect(() => {
    alive.current = true;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      await load(ac.signal);
      if (!ac.signal.aborted) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => { alive.current = false; revision.current++; ac.abort(); clearTimeout(timer); };
  }, [base, sessionId]);
  const mutate = async (path: string, method: string, body: Record<string, unknown>) => {
    setBusy(true); setError(''); setSaved(false);
    revision.current++;
    try {
      const result = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }) }) as { settings?: BotGoalSettings };
      if (!alive.current) return;
      if (result.settings) { setDraft(result.settings); setSaved(true); }
      await load();
    } catch (err) { if (alive.current) setError(String(err)); }
    finally { if (alive.current) setBusy(false); }
  };
  const panel = goalsPanelState(snapshot?.goals ?? []);
  useEffect(() => {
    if (snapshot && selectedGoalId && !snapshot.goals.some(goal => goal.id === selectedGoalId && goalActions(goal.status).length > 0)) onSelectGoal?.(null);
  }, [snapshot, selectedGoalId, onSelectGoal]);
  const attention = needsGoalAttention(panel);
  const shell = goalPanelShell(attention);
  const narrow = useNarrowChat();
  const [narrowOpen, setNarrowOpen] = useState(false);
  const selectedTitle = panel.items.find(goal => goal.id === selectedGoalId)?.title;
  if (hideGoalPanel(listFailed, snapshot, panel.show, attention)) return null;
  const phoneLabel = `${attention ? t('goals.attention') : `${t('goals.title')} (${panel.count})`}${selectedTitle ? ` · ${selectedTitle}` : ''}`;
  return <details className={`bot-goals${narrow && narrowOpen ? ' is-open' : ''}`} data-testid={shell.testId} open={narrow ? narrowOpen : shell.open}>
    <summary aria-expanded={narrow ? narrowOpen : undefined} onClick={event => {
      if (!narrow) return;
      event.preventDefault();
      setNarrowOpen(value => !value);
    }}>{phoneLabel}</summary>
    <div className="bot-goals__body">
      {error && <p role="alert">{t('goals.error', { error })}</p>}
      {onSelectGoal && !attention && <label>{t('goals.target')}<select value={selectedGoalId ?? ''} onChange={e => onSelectGoal(e.target.value || null)}>
        <option value="">{t('goals.automatic')}</option>
        {panel.items.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
      </select></label>}
      <div className="bot-goals__list">{panel.items.map(goal => <article key={goal.id} data-testid={`bot-goal-${goal.id}`}>
        <header><strong>{goal.title}</strong><span>{t(`goals.status.${goal.status}`)}</span></header>
        <dl>
          {goal.progress && <><dt>{t('goals.progress')}</dt><dd>{goal.progress}</dd></>}
          {(goal.nextStep || goal.wait) && <><dt>{t('goals.next')}</dt><dd>{goal.nextStep || goal.wait?.description || `${goal.wait?.source}: ${goal.wait?.correlationId}`}</dd></>}
          {goal.blockedReason && <><dt>{t('goals.blocked')}</dt><dd>{goal.blockedReason}</dd></>}
          {goal.strategy && <><dt>{t('goals.preference')}</dt><dd>{t(`goals.strategy.${goal.strategy}`)}</dd></>}
          {goal.strategyReason && <><dt>{t('goals.reason')}</dt><dd>{goal.strategyReason}</dd></>}
          {goal.evidence?.length > 0 && <><dt>{t('goals.evidence')}</dt><dd><ul>{goal.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></>}
        </dl>
        <p>{t('goals.usage', { cost: (goal.costUsd ?? 0).toFixed(2), budget: goal.budgetUsd ?? 0 })}</p>
        {goal.draining && <p>{t('goals.draining')}</p>}
        <div className="bot-goals__actions">{goalActions(goal.status).map(action => <button className="btn btn-sm" key={action} type="button" disabled={busy} data-testid={action === 'verify' ? `bot-goal-verify-${goal.id}` : undefined} onClick={() => void mutate(`${base}/${encodeURIComponent(goal.id)}/actions`, 'POST', action === 'verify' ? goalVerifyRequest(true) : { action })}>{t(`goals.${action}`)}</button>)}
        {goal.status === 'pending_review' && (rejectingId === goal.id
          ? <form data-testid={`bot-goal-reject-form-${goal.id}`} onSubmit={e => { e.preventDefault(); const reason = (e.currentTarget.elements.namedItem('reason') as { value?: string } | null)?.value ?? ''; void mutate(`${base}/${encodeURIComponent(goal.id)}/actions`, 'POST', goalVerifyRequest(false, reason)).then(() => { if (alive.current) setRejectingId(current => current === goal.id ? null : current); }); }}>
            <label>{t('goals.rejectReason')}<input name="reason" type="text" maxLength={500} placeholder={t('goals.rejectReasonPlaceholder')} /></label>
            <button className="btn btn-sm" type="submit" disabled={busy} data-testid={`bot-goal-reject-submit-${goal.id}`}>{t('goals.rejectSubmit')}</button>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setRejectingId(null)}>{t('goals.rejectDismiss')}</button>
          </form>
          : <button className="btn btn-sm" type="button" disabled={busy} data-testid={`bot-goal-reject-${goal.id}`} onClick={() => setRejectingId(goal.id)}>{t('goals.reject')}</button>)}
        <GoalLimits goal={goal} busy={busy} attention={attention} onAction={body=>mutate(`${base}/${encodeURIComponent(goal.id)}/actions`, 'POST', body)} /></div>
      </article>)}</div>
      {draft && !attention && <details><summary>{t('goals.settings')}</summary><form className="bot-goals__settings" onSubmit={e => { e.preventDefault(); void mutate(`${base}/settings`, 'PATCH', { ...draft }); }}>
        {(['maxConcurrent', 'defaultBudgetUsd', 'maxAttempts', 'maxNoProgress'] as const).map((key, index) => <label key={key}>{t((['goals.concurrency', 'goals.budget', 'goals.attempts', 'goals.noProgress'] as const)[index])}<input type="number" min={key === 'defaultBudgetUsd' ? 0.01 : 1} max={key === 'maxConcurrent' ? 32 : undefined} step={key === 'defaultBudgetUsd' ? 0.01 : 1} required value={draft[key]} onChange={e => { setSaved(false); setDraft({ ...draft, [key]: Number(e.target.value) }); }}/></label>)}
        <label>{t('goals.preference')}<select value={draft.preferredStrategy} onChange={e => { setSaved(false); setDraft({ ...draft, preferredStrategy: e.target.value as GoalStrategy }); }}>{(['auto', 'direct', 'subagent', 'bot_delegate', 'ptc', 'team_dag', 'swarm', 'browser', 'computer', 'deep_research'] as const).map(strategy => <option key={strategy} value={strategy}>{t(`goals.strategy.${strategy}`)}</option>)}</select></label>
        <button className="btn btn-sm" disabled={busy}>{t('goals.save')}</button>
        {saved && <p role="status">{t('goals.saved')}</p>}
      </form></details>}
    </div>
  </details>;
}

function needsGoalAttention(panel: ReturnType<typeof goalsPanelState>): boolean {
  return !panel.show && panel.items.length === 1 && ['pending_review','blocked','paused'].includes(panel.items[0].status);
}
function hideGoalPanel(failed:boolean,snapshot:BotGoalsSnapshot|null,multiple:boolean,attention:boolean):boolean {
  return failed || !snapshot || (!multiple && !attention);
}
function goalPanelShell(attention:boolean) {
  return {testId:attention?'bot-goal-attention':'bot-goals',open:attention||undefined};
}
/** False until mount, so the desktop markup stays a native details element. */
function useNarrowChat(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  return narrow;
}
function GoalLimits({goal,busy,attention,onAction}:{goal:BotGoalView;busy:boolean;attention:boolean;onAction:(body:Record<string,unknown>)=>Promise<void>}) {
  const {t}=useI18n();
  return <>
        {['blocked','paused','pending_review'].includes(goal.status) && <form data-testid={`bot-goal-extend-${goal.id}`} onSubmit={e => {
          e.preventDefault(); const data = new FormData(e.currentTarget);
          void onAction( {action:'extend',additionalBudgetUsd:Number(data.get('budget')),additionalAttempts:Number(data.get('attempts'))});
        }}>
          <label>{t('goals.addBudget')}<input name="budget" type="number" min="0" step="0.01" defaultValue="0" required /></label>
          <label>{t('goals.addAttempts')}<input name="attempts" type="number" min="0" step="1" defaultValue="0" required /></label>
          <button className="btn btn-sm" type="submit" disabled={busy}>{t('goals.extend')}</button>
          <p>{t('goals.extendHint')}</p>
        </form>}
        {goalActions(goal.status).length > 0 && !attention && <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void onAction( { action: 'reprioritize', priority: Number(data.get('priority')) }); }}>
          <label>{t('goals.priority')}<input key={goal.priority} name="priority" type="number" min={-100} max={100} required defaultValue={goal.priority}/></label><button className="btn btn-sm" disabled={busy}>{t('goals.setPriority')}</button>
        </form>}
  </>;
}

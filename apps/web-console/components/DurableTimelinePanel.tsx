'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  canRollbackToStep,
  durableErrorMessage,
  durableSessionEndpoint,
  durableStepResolveEndpoint,
  isStepNeedsOperatorResolve,
  type DurableRunView,
  type DurableSessionPayload,
  type DurableStepView,
} from '@/lib/durable';

const KNOWN_RUN_STATUSES = new Set([
  'running',
  'waiting_park',
  'completing',
  'rolling_back',
  'rolled_back',
  'needs_reconcile',
  'resumable',
  'suspended_interrupted',
  'completed',
  'failed',
  'aborted',
]);

const KNOWN_STEP_PHASES = new Set([
  'planned',
  'dispatched',
  'parked',
  'committed',
  'failed',
  'unknown',
  'compensating',
  'compensated',
  'compensation_failed',
]);

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface DurableActions {
  busy: boolean;
  notice: string | null;
  onRollback: (stepId: string) => void;
  onFork: (stepId: string) => void;
  onReconcile: () => void;
  onResolve: (stepId: string, decision: 'committed' | 'not_applied') => void;
  onRefresh: () => void;
}

function localizedEnum(t: Translate, prefix: string, value: string, known: ReadonlySet<string>): string {
  return known.has(value) ? t(`${prefix}.${value}` as MessageKey) : value;
}

function DurableRunHeader({
  run,
  hasUnknown,
  actions,
}: {
  run: DurableRunView;
  hasUnknown: boolean;
  actions: DurableActions;
}) {
  const { t } = useI18n();
  const statusText = localizedEnum(t, 'ops.durable.runStatus', run.status, KNOWN_RUN_STATUSES);
  const pivotText = t(run.passedPivot ? 'ops.durable.pivotPassed' : 'ops.durable.pivotClear');
  return (
    <div className="durable-panel__head">
      <div className="durable-panel__meta">
        <strong>{t('ops.durable.title')}</strong>
        <span className="muted small">
          {statusText} · {t('ops.durable.epochLabel', { n: run.fencingEpoch })} ·{' '}
          {t('ops.durable.restartsLabel', { n: run.restarts })} · {pivotText}
        </span>
      </div>
      <div className="durable-panel__toolbar">
        {hasUnknown ? (
          <button type="button" className="btn btn-sm" disabled={actions.busy} onClick={actions.onReconcile}>
            {t('ops.durable.reconcile')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-sm" disabled={actions.busy} onClick={actions.onRefresh}>
          {t('ops.durable.refresh')}
        </button>
      </div>
    </div>
  );
}

function DurableChildRunsList({ childRuns }: { childRuns: DurableRunView[] }) {
  const { t } = useI18n();
  if (childRuns.length === 0) return null;
  return (
    <div className="durable-panel__children">
      <p className="muted small">{t('ops.durable.childRunsTitle', { n: childRuns.length })}</p>
      <ul className="traj-turn__list">
        {childRuns.map((child) => (
          <li key={child.runId} className="small">
            <code>{child.runId}</code> · {localizedEnum(t, 'ops.durable.runStatus', child.status, KNOWN_RUN_STATUSES)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DurableStepResolveButtons({ step, actions }: { step: DurableStepView; actions: DurableActions }) {
  const { t } = useI18n();
  if (!isStepNeedsOperatorResolve(step)) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={actions.busy}
        onClick={() => actions.onResolve(step.stepId, 'committed')}
      >
        {t('ops.durable.resolveCommitted')}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={actions.busy}
        onClick={() => actions.onResolve(step.stepId, 'not_applied')}
      >
        {t('ops.durable.resolveNotApplied')}
      </button>
    </>
  );
}

function DurableStepActions({ step, actions }: { step: DurableStepView; actions: DurableActions }) {
  const { t } = useI18n();
  return (
    <span className="durable-step__actions">
      {canRollbackToStep(step) ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={actions.busy}
          onClick={() => actions.onRollback(step.stepId)}
        >
          {t('ops.durable.rollback')}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={actions.busy}
        onClick={() => actions.onFork(step.stepId)}
      >
        {t('ops.durable.fork')}
      </button>
      <DurableStepResolveButtons step={step} actions={actions} />
    </span>
  );
}

function DurableStepItem({ step, actions }: { step: DurableStepView; actions: DurableActions }) {
  const { t } = useI18n();
  const phaseLabel = localizedEnum(t, 'ops.durable.phase', step.phase, KNOWN_STEP_PHASES);
  const title = step.toolName ?? step.kind;
  return (
    <li className="durable-step">
      <div className="durable-step__row">
        <span className="traj-kind">T{step.turn}·W{step.waveIndex}</span>
        <span className="traj-type">{title}</span>
        <span className="muted small">{phaseLabel} · {step.effectClass}</span>
        <DurableStepActions step={step} actions={actions} />
      </div>
      {step.errorText ? <p className="muted small">{step.errorText}</p> : null}
    </li>
  );
}

function DurableTimelineBody({
  payload,
  run,
  actions,
}: {
  payload: DurableSessionPayload;
  run: DurableRunView;
  actions: DurableActions;
}) {
  const { t } = useI18n();
  const hasUnknown = payload.steps.some(isStepNeedsOperatorResolve);
  return (
    <section className="traj-turn durable-panel" aria-label={t('ops.durable.title')}>
      <DurableRunHeader run={run} hasUnknown={hasUnknown} actions={actions} />
      <p className="muted small">{t('ops.durable.hint')}</p>
      {actions.notice ? <p className="small" role="status">{actions.notice}</p> : null}
      <DurableChildRunsList childRuns={payload.childRuns} />
      <p className="muted small">{t('ops.durable.stepsTitle', { n: payload.steps.length })}</p>
      {payload.steps.length === 0 ? (
        <p className="muted small">{t('ops.durable.noSteps')}</p>
      ) : (
        <ul className="traj-turn__list">
          {payload.steps.map((step) => (
            <DurableStepItem key={step.stepId} step={step} actions={actions} />
          ))}
        </ul>
      )}
    </section>
  );
}

function useDurablePanelActions(sessionId: string, reload: () => Promise<void>): DurableActions {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runAction = useCallback(
    async (fn: () => Promise<string>) => {
      setBusy(true);
      try {
        const msg = await fn();
        setNotice(msg);
        await reload();
      } catch (e) {
        setNotice(t('ops.durable.actionFailed', { message: durableErrorMessage(e) }));
      } finally {
        setBusy(false);
      }
    },
    [reload, t]
  );

  const onRollback = useCallback(
    (stepId: string) => {
      void runAction(async () => {
        const res = (await api(durableSessionEndpoint(sessionId, '/rollback'), {
          method: 'POST',
          body: JSON.stringify({ stepId }),
        })) as { blockedByPivot?: boolean };
        return res.blockedByPivot ? t('ops.durable.actionPivotBlocked') : t('ops.durable.actionDone');
      });
    },
    [runAction, sessionId, t]
  );

  const onFork = useCallback(
    (stepId: string) => {
      void runAction(async () => {
        const res = (await api(durableSessionEndpoint(sessionId, '/fork'), {
          method: 'POST',
          body: JSON.stringify({ stepId }),
        })) as { session?: { id?: string } };
        return t('ops.durable.actionForked', { id: res.session?.id ?? '' });
      });
    },
    [runAction, sessionId, t]
  );

  const onReconcile = useCallback(() => {
    void runAction(async () => {
      await api(durableSessionEndpoint(sessionId, '/reconcile'), { method: 'POST', body: '{}' });
      return t('ops.durable.actionDone');
    });
  }, [runAction, sessionId, t]);

  const onResolve = useCallback(
    (stepId: string, decision: 'committed' | 'not_applied') => {
      void runAction(async () => {
        await api(durableStepResolveEndpoint(sessionId, stepId), {
          method: 'POST',
          body: JSON.stringify({ decision }),
        });
        return t('ops.durable.actionDone');
      });
    },
    [runAction, sessionId, t]
  );

  return { busy, notice, onRollback, onFork, onReconcile, onResolve, onRefresh: () => void reload() };
}

export function DurableTimelinePanel({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<DurableSessionPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = (await api(durableSessionEndpoint(sessionId))) as DurableSessionPayload;
      setData(body);
      setErr(null);
    } catch (e) {
      setErr(durableErrorMessage(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const actions = useDurablePanelActions(sessionId, load);

  if (err) {
    return <p className="muted small">{t('ops.durable.loadFailed', { message: err })}</p>;
  }
  if (!data?.latestRun) {
    return <p className="muted small">{t('ops.durable.empty')}</p>;
  }
  return <DurableTimelineBody payload={data} run={data.latestRun} actions={actions} />;
}

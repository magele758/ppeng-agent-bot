'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { formatCompactTokens, formatCostUsd } from '@/lib/session-chrome';
import {
  errorHintCode,
  errorPayloadMessage,
  isErrorKind,
  maxDurationMs,
  summarizeGroup,
  type TraceGroup,
  type TraceGroupKind
} from '@/lib/trace-groups';

export interface BulkOpen {
  version: number;
  open: boolean;
}

function groupLabelKey(kind: TraceGroupKind): MessageKey {
  switch (kind) {
    case 'turn':
      return 'ops.turnLabel';
    case 'span':
      return 'ops.spanLabel';
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled trace group kind: ${_exhaustive}`);
    }
  }
}

function hintKeys(kind: string): { what: MessageKey; why: MessageKey; next: MessageKey } {
  const code = errorHintCode(kind);
  switch (code) {
    case 'modelError':
      return { what: 'ops.hint.modelError.what', why: 'ops.hint.modelError.why', next: 'ops.hint.modelError.next' };
    case 'recoveryAbort':
      return {
        what: 'ops.hint.recoveryAbort.what',
        why: 'ops.hint.recoveryAbort.why',
        next: 'ops.hint.recoveryAbort.next'
      };
    case 'cancel':
      return { what: 'ops.hint.cancel.what', why: 'ops.hint.cancel.why', next: 'ops.hint.cancel.next' };
    case 'truncated':
      return { what: 'ops.hint.truncated.what', why: 'ops.hint.truncated.why', next: 'ops.hint.truncated.next' };
    case 'goalUnmet':
      return { what: 'ops.hint.goalUnmet.what', why: 'ops.hint.goalUnmet.why', next: 'ops.hint.goalUnmet.next' };
    case 'generic':
      return { what: 'ops.hint.generic.what', why: 'ops.hint.generic.why', next: 'ops.hint.generic.next' };
    default: {
      const _exhaustive: never = code;
      throw new Error(`unhandled error hint code: ${_exhaustive}`);
    }
  }
}

/** `+1.2s` from the turn's first event; falls back to the raw timestamp. */
function offsetLabel(startTs: string, ts: string): string {
  const a = Date.parse(startTs);
  const b = Date.parse(ts);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ts;
  return `+${((b - a) / 1000).toFixed(2)}s`;
}

function TurnItem({
  group,
  maxMs,
  bulk
}: {
  group: TraceGroup;
  maxMs: number;
  bulk: BulkOpen;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (bulk.version > 0 && ref.current) ref.current.open = bulk.open;
  }, [bulk]);

  const summary = useMemo(() => summarizeGroup(group), [group]);
  const pct = group.durationMs != null ? Math.max(4, Math.round((group.durationMs / maxMs) * 100)) : 8;
  const firstError = group.events.find((ev) => isErrorKind(ev.kind, ev.payload));
  const keys = firstError ? hintKeys(firstError.kind) : null;
  const reason = firstError ? errorPayloadMessage(firstError.payload) : '';

  return (
    <details ref={ref} className={`trace-group${group.hasError ? ' trace-group--err' : ''}`} data-testid="trace-turn">
      <summary className="trace-group__head">
        <span className="trace-group__inner">
          <span className="trace-group__chevron" aria-hidden="true" />
          <span className="trace-group__label">{t(groupLabelKey(group.kind), { n: group.turnIndex })}</span>
          <span className="trace-group__meta">
            {group.durationMs != null ? `${(group.durationMs / 1000).toFixed(2)}s · ` : ''}
            {t('ops.eventCount', { n: group.events.length })}
            {summary.toolCalls > 0 ? ` · ${t('ops.trace.toolsCount', { n: summary.toolCalls })}` : ''}
            {summary.totalTokens != null
              ? ` · ${t('ops.trace.tokensCount', { n: formatCompactTokens(summary.totalTokens) })}`
              : ''}
            {summary.costUsd != null ? ` · ${formatCostUsd(summary.costUsd)}` : ''}
          </span>
          {group.hasError ? <span className="ops-tag ops-tag--err">{t('ops.errorTag')}</span> : null}
          {keys ? (
            <span className="trace-turn__error" data-testid="trace-turn-error">
              <strong>{t(keys.what)}</strong>
              {' · '}
              {reason || t(keys.why)}
            </span>
          ) : null}
        </span>
        <span className="trace-group__bar" style={{ width: `${pct}%` }} aria-hidden="true" />
      </summary>
      <div className="trace-group__body">
        {group.events.map((ev, i) => {
          const err = isErrorKind(ev.kind, ev.payload);
          const k = err ? hintKeys(ev.kind) : null;
          return (
            <details key={`${group.id}-${i}`} className={`trace-row${err ? ' trace-row--err' : ''}`}>
              <summary className="trace-row__head">
                <span className="trace-row__inner">
                  <span className="trace-row__chevron" aria-hidden="true" />
                  <span className="trace-kind">{ev.kind}</span>
                  <span className="trace-ts" title={ev.ts}>
                    {offsetLabel(group.startTs, ev.ts)}
                  </span>
                </span>
              </summary>
              {k ? (
                <div className="trace-error-hint">
                  <div>
                    <strong>{t('ops.hintWhat')}</strong>：{t(k.what)}
                  </div>
                  <div>
                    <strong>{t('ops.hintWhy')}</strong>：{errorPayloadMessage(ev.payload) || t(k.why)}
                  </div>
                  <div>
                    <strong>{t('ops.hintNext')}</strong>：{t(k.next)}
                  </div>
                </div>
              ) : null}
              <pre className="trace-payload">{JSON.stringify(ev.payload ?? {}, null, 2)}</pre>
            </details>
          );
        })}
      </div>
    </details>
  );
}

/** Turn summaries (collapsed). `groups` is already filtered by the caller. */
export function TraceTurnList({ groups, bulk }: { groups: TraceGroup[]; bulk: BulkOpen }) {
  const maxMs = useMemo(() => maxDurationMs(groups), [groups]);
  return (
    <>
      {groups.map((g) => (
        <TurnItem key={g.id} group={g} maxMs={maxMs} bulk={bulk} />
      ))}
    </>
  );
}

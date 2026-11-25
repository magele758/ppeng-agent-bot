'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { seedDetailsOpen } from '@/lib/seed-details-open';
import { DurableTimelinePanel } from './DurableTimelinePanel';

interface TrajectoryRecord {
  kind: string;
  seq: number;
  eventType: string;
  surfaceHidden: boolean;
  data: unknown;
  timestamp?: number;
}

interface TrajectoryTurn {
  turn: number | null;
  startSeq: number | null;
  endSeq: number | null;
  open: boolean;
  status?: string;
  endReason?: string;
  rollbackReason?: string;
  records: TrajectoryRecord[];
}

interface TrajectoryBody {
  sessionId: string;
  turns: TrajectoryTurn[];
}

function isTrajTurnDefaultOpen(turn: TrajectoryTurn, index: number, total: number): boolean {
  if (turn.status === 'rolled_back' || turn.open) return true;
  return total > 0 && index === total - 1;
}

export function TrajectoryPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [data, setData] = useState<TrajectoryBody | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setData(null);
      return;
    }
    try {
      const body = (await api(`/api/sessions/${encodeURIComponent(sessionId)}/trajectory`)) as TrajectoryBody;
      setData(body);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    if (!sessionId) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load, sessionId]);

  if (!sessionId) {
    return <div className="empty-hint">{t('ops.eventLogEmptyPick')}</div>;
  }
  if (err) {
    return <div className="empty-hint">{err}</div>;
  }
  if (!data || data.turns.length === 0) {
    return (
      <div className="traj-panel" role="region" aria-label={t('ops.eventLogAria')}>
        <DurableTimelinePanel sessionId={sessionId} />
        <div className="empty-hint">{t('ops.eventLogEmpty')}</div>
      </div>
    );
  }

  return (
    <div className="traj-panel" role="region" aria-label={t('ops.eventLogAria')}>
      <DurableTimelinePanel sessionId={sessionId} />
      <p className="muted small">{t('ops.eventLogHint')}</p>
      {data.turns.map((turn, idx) => {
        const statusLabel = turn.status
          ?? (turn.open ? t('ops.statusInProgress') : t('ops.statusClosed'));
        return (
          <details
            key={`${turn.startSeq ?? idx}-${turn.turn ?? 'x'}`}
            className={`traj-turn${turn.status === 'rolled_back' ? ' traj-turn--back' : ''}`}
            ref={(el) => seedDetailsOpen(el, isTrajTurnDefaultOpen(turn, idx, data.turns.length))}
          >
            <summary className="traj-turn__head">
              <span className="traj-turn__inner">
                <span className="traj-turn__title">
                  <span className="traj-turn__chevron" aria-hidden="true" />
                  <span>{t('ops.trajRun', { n: turn.turn ?? idx })}</span>
                </span>
                <span className="muted">
                  {statusLabel}
                  {turn.rollbackReason ? ` · ${turn.rollbackReason}` : ''}
                  {turn.endReason ? ` · ${turn.endReason}` : ''}
                  {' · '}
                  {t('ops.eventCount', { n: turn.records.length })}
                </span>
              </span>
            </summary>
            <ul className="traj-turn__list">
              {turn.records.map((r) => (
                <li key={r.seq}>
                  <details className="traj-row">
                    <summary className="traj-row__head">
                      <span className="traj-row__inner">
                        <span className="traj-row__chevron" aria-hidden="true" />
                        <span className="traj-kind">{r.kind}</span>
                        <span className="traj-type">{r.eventType}</span>
                        <span className="muted">#{r.seq}</span>
                        {r.surfaceHidden ? <span className="muted">{t('ops.hidden')}</span> : null}
                      </span>
                    </summary>
                    <pre className="traj-row__payload" aria-label={t('ops.payload')}>
                      {JSON.stringify(r.data ?? {}, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

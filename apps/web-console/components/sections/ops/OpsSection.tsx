'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { OpsPanel } from '../../OpsPanel';
import { useLab } from '../../shell/LabProvider';
import { SectionFrame } from '../SectionFrame';
import { HealthView } from './HealthView';
import './ops.css';

type TraceRow = { kind: string; ts: string; payload: unknown };

function TrajectoryView() {
  const { sessions, selectedSessionId, openSession } = useLab();
  const [traceRows, setTraceRows] = useState<TraceRow[]>([]);
  const [traceError, setTraceError] = useState(false);
  const [traceLoaded, setTraceLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTraceRows([]);
    setTraceError(false);
    setTraceLoaded(false);

    const loadTrace = async () => {
      if (!selectedSessionId) return;
      const el = document.getElementById('traceTimeline');
      const top = el?.scrollTop ?? 0;
      try {
        const { events } = (await api(
          `/api/traces?sessionId=${encodeURIComponent(selectedSessionId)}&limit=500`
        )) as { events?: TraceRow[] };
        if (cancelled) return;
        setTraceRows(events ?? []);
        setTraceError(false);
        setTraceLoaded(true);
      } catch {
        if (cancelled) return;
        setTraceError(true);
        setTraceLoaded(true);
      }
      requestAnimationFrame(() => {
        const next = document.getElementById('traceTimeline');
        if (next) next.scrollTop = top;
      });
    };

    void loadTrace();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadTrace();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedSessionId]);

  return (
    <OpsPanel
      active
      sessions={sessions}
      selectedSessionId={selectedSessionId}
      onSelectSession={(id) => void openSession(id)}
      traceRows={traceRows}
      traceError={traceError}
      traceLoaded={traceLoaded}
    />
  );
}

export function OpsSection({ active }: { active: boolean }) {
  return (
    <SectionFrame
      section="ops"
      active={active}
      renderSub={(sub) => {
        switch (sub) {
          case 'trajectory':
            return <TrajectoryView />;
          case 'health':
            return <HealthView />;
          default:
            return null;
        }
      }}
    />
  );
}

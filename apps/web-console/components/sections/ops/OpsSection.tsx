'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { OpsPanel } from '../../OpsPanel';
import { useLab } from '../../shell/LabProvider';
import { SubTabs } from '../../ui';
import { HealthView } from './HealthView';
import './ops.css';

type TraceRow = { kind: string; ts: string; payload: unknown };

function TrajectoryView() {
  const { sessions, selectedSessionId, openSession } = useLab();
  const [traceRows, setTraceRows] = useState<TraceRow[]>([]);

  const loadTrace = useCallback(async () => {
    if (!selectedSessionId) {
      setTraceRows([]);
      return;
    }
    const el = document.getElementById('traceTimeline');
    const top = el?.scrollTop ?? 0;
    try {
      const { events } = (await api(
        `/api/traces?sessionId=${encodeURIComponent(selectedSessionId)}&limit=500`
      )) as { events?: TraceRow[] };
      setTraceRows(events ?? []);
    } catch {
      setTraceRows([]);
    }
    requestAnimationFrame(() => {
      const next = document.getElementById('traceTimeline');
      if (next) next.scrollTop = top;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    setTraceRows([]);
  }, [selectedSessionId]);

  useEffect(() => {
    void loadTrace();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadTrace();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadTrace]);

  return (
    <OpsPanel
      active
      sessions={sessions}
      selectedSessionId={selectedSessionId}
      onSelectSession={(id) => void openSession(id)}
      traceRows={traceRows}
    />
  );
}

/** 设置 → 运维。子页签仍是会话轨迹 / 系统健康。 */
export function OpsWorkspace({
  pane,
  onSelectPane
}: {
  pane: string | null;
  onSelectPane: (pane: string) => void;
}) {
  const { t } = useI18n();
  const sub = pane === 'health' ? 'health' : 'trajectory';
  return (
    <div className="ops-workspace" id="section-ops">
      <h2 className="ops-workspace__title">{t('shell.nav.ops')}</h2>
      <p className="muted small">{t('shell.desc.ops')}</p>
      <SubTabs
        items={[
          { id: 'trajectory', label: t('shell.sub.ops.trajectory') },
          { id: 'health', label: t('shell.sub.ops.health') }
        ]}
        active={sub}
        onSelect={onSelectPane}
        ariaLabel={t('shell.nav.subPages')}
        idPrefix="section-ops"
      />
      <div id={`section-ops-${sub}`}>
        {sub === 'health' ? <HealthView /> : <TrajectoryView />}
      </div>
    </div>
  );
}

'use client';

import { useI18n } from '@/lib/i18n';

export interface SessionRecapBarProps {
  shown: boolean;
  canManual: boolean;
  status: 'hidden' | 'loading' | 'done' | 'failed';
  text: string;
  requestManual: () => void;
  dismiss: () => void;
}

function hasRecapContent(recap: SessionRecapBarProps): boolean {
  return recap.shown && recap.status === 'done' && Boolean(recap.text.trim());
}

export function SessionRecapBar(recap: SessionRecapBarProps) {
  const { t } = useI18n();
  if (!recap.shown && !recap.canManual) return null;
  if (hasRecapContent(recap)) {
    return <div className="session-recap-bar">
      <div className="session-recap" role="status" data-testid="session-recap">
        <p className="session-recap__text">{recap.text}</p>
        <button type="button" className="session-recap__dismiss" aria-label={t('play.sessionRecap.dismiss')} onClick={recap.dismiss}>×</button>
      </div>
    </div>;
  }
  return <div className="session-recap-bar">
    <button type="button" className="session-recap__manual" data-testid="session-recap-manual"
      disabled={recap.status === 'loading'} aria-busy={recap.status === 'loading'} onClick={recap.requestManual}>
      {t('play.sessionRecap.manual')}
    </button>
  </div>;
}

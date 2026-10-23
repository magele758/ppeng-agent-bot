'use client';
import { useI18n } from '@/lib/i18n';
import type { RiskAdvisory } from '@/lib/risk-advisory';
import styles from './RiskAdvisoryCard.module.css';

export function RiskAdvisoryCard({ notice }: { notice: RiskAdvisory }) {
  const { t } = useI18n();
  return (
    <aside className={`${styles.card} ${notice.severity === 'warning' ? styles.warning : ''}`} data-testid="risk-advisory" aria-label={t('play.riskAdvisory.title')}>
      <div className={styles.heading}>
        <span aria-hidden="true">{notice.severity === 'warning' ? '△' : 'ⓘ'}</span>
        <strong>{t(notice.severity === 'warning' ? 'play.riskAdvisory.warning' : 'play.riskAdvisory.title')}</strong>
      </div>
      <ul>{notice.signals.map(signal => <li key={signal}>{t(`play.riskAdvisory.${signal}`)}</li>)}</ul>
      <p>{t('play.riskAdvisory.explanation')}</p>
      <details>
        <summary>{t('play.riskAdvisory.details')}</summary>
        <pre>{notice.raw}</pre>
      </details>
    </aside>
  );
}

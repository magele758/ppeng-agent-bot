'use client';

import { evolutionChipVisible } from '@/lib/evolution-surface';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { formatHash } from '@/lib/nav';
import { overallHealth, type HealthLevel } from '@/lib/ops-health';
import { useOpsStatus } from './sections/ops/useOpsStatus';

const LEVEL_KEY: Record<HealthLevel, MessageKey> = {
  ok: 'ops.status.ok',
  warn: 'ops.status.warn',
  fail: 'ops.status.fail'
};

/** One quiet health chip. Self-heal shows only while it is running. Evolution stays hidden. */
export function GlobalStatusBar() {
  const { t } = useI18n();
  const { status } = useOpsStatus();
  const level = overallHealth({
    reachable: status.reachable,
    ready: status.ready,
    doctor: null,
    configWarnings: 0
  }).level;
  const heal = status.selfHealActive?.length ?? 0;
  const showEvolution = evolutionChipVisible(status.evolution?.activeWorktrees ?? 0);
  const href = formatHash({ section: 'ops', sub: 'health' });

  return (
    <div className="global-status" role="group" aria-label={t('ops.status.aria')}>
      <a
        href={href}
        className={`global-status__chip global-status__link ops-chip ops-chip--${status.loaded ? level : 'checking'}`}
        title={t('ops.status.open')}
      >
        <span className="ops-dot" aria-hidden="true" />
        {status.loaded ? t(LEVEL_KEY[level]) : t('ops.status.checking')}
      </a>
      {heal > 0 ? (
        <a href={href} className="global-status__chip global-status__link is-run">
          {t('ops.status.healRunning', { n: heal })}
        </a>
      ) : null}
      {showEvolution ? (
        <a href={href} className="global-status__chip global-status__link is-run" data-testid="evolution-status-chip">
          {t('ops.status.evoRunning', { n: status.evolution?.activeWorktrees ?? 0 })}
        </a>
      ) : null}
    </div>
  );
}

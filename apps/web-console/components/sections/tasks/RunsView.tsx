'use client';

import { useI18n } from '@/lib/i18n';
import { RoutineHealthCenter } from '../../bot-work/RoutineHealth';
import { OrchestrationPanel } from '../../OrchestrationPanel';
import { EmptyState, SettingsGroup } from '../../ui';
import { useLab } from '../../shell/LabProvider';
import { ListFallback } from './ListFallback';
import styles from './tasks.module.css';

export function RunsView() {
  const { t } = useI18n();
  const { orchestrationRuns, swarmRuns, listState } = useLab();
  return (
    <>
      <RoutineHealthCenter />
      <OrchestrationPanel runs={orchestrationRuns} loadError={listState.orchestrationRuns.error} />
      <SettingsGroup title={t('tasks.runs.swarmTitle')} description={t('tasks.runs.swarmDesc')} collapsible>
        <ListFallback
          error={listState.swarmRuns.error}
          count={swarmRuns.length}
          empty={<EmptyState title={t('tasks.runs.swarmEmptyTitle')} description={t('tasks.runs.swarmEmptyDesc')} />}
        >
          <div id="listSwarmRuns" className={styles.list}>
            {swarmRuns.map((r) => (
              <div key={r.id} className={`list-item ${styles.row}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{r.goal || r.id}</span>
                  <span className={styles.status}>{r.status}</span>
                </div>
                <div className={styles.rowMeta}>
                  <span>{t('tasks.runs.strategy', { strategy: r.strategy })}</span>
                  <span>{r.id}</span>
                </div>
              </div>
            ))}
          </div>
        </ListFallback>
      </SettingsGroup>
    </>
  );
}

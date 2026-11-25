'use client';

import { useI18n } from '@/lib/i18n';
import type { JobRow } from '../../shell/LabProvider';
import { formatIsoTimestamp } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

function JobMetaStrip({ job }: { job: JobRow }) {
  const { t, locale } = useI18n();
  const created = formatIsoTimestamp(job.createdAt, locale);
  const updated = formatIsoTimestamp(job.updatedAt, locale);

  return (
    <div className={styles.metaStrip}>
      {job.id ? <span className={styles.monoTag}>{job.id}</span> : null}
      {created ? <span>{t('botWork.createdAt', { time: created })}</span> : null}
      {updated ? <span>{t('botWork.updatedAt', { time: updated })}</span> : null}
    </div>
  );
}

export function TaskQueueJobDetail({
  job,
  onOpenSession
}: {
  job: JobRow;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <div className={styles.detailBody}>
        <JobMetaStrip job={job} />
        <section className={styles.detailSection}>
          <h4 className={styles.sectionHeading}>{t('tasks.queue.commandHeading')}</h4>
          <pre className={styles.codeBlock}>{job.command || t('tasks.queue.unnamedJob')}</pre>
        </section>
        <section className={styles.detailSection}>
          <h4 className={styles.sectionHeading}>{t('tasks.queue.outputHeading')}</h4>
          {job.result ? (
            <pre className={styles.codeBlock}>{job.result}</pre>
          ) : (
            <p className={styles.mutedNote}>{t('tasks.queue.noOutput')}</p>
          )}
        </section>
      </div>
      <footer className={styles.detailFooter}>
        <span className={styles.mutedNote}>{job.id ? job.id : t('tasks.queue.jobTypeBadge')}</span>
        <div className={styles.footerActions}>
          {job.sessionId ? (
            <button
              type="button"
              className={`${styles.pillBtn} ${styles.pillBtnPrimary}`}
              onClick={() => onOpenSession(job.sessionId as string)}
            >
              {t('tasks.openSession')}
            </button>
          ) : null}
        </div>
      </footer>
    </>
  );
}

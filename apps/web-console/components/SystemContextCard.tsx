'use client';
import { useI18n } from '@/lib/i18n';
import type { SystemContextNotice } from '@/lib/system-context-notice';
import { MarkdownHtml } from './MarkdownHtml';
import styles from './SystemContextCard.module.css';

export function SystemContextCard({ notice }: { notice: SystemContextNotice }) {
  const { t } = useI18n();
  return (
    <article className={styles.card} data-testid={`system-${notice.kind}-card`}>
      <header className={styles.header}>
        <strong>{t(notice.kind === 'summary' ? 'play.systemContext.summaryTitle' : 'play.systemContext.jevTitle')}</strong>
        <span className={styles.badge}>{t(notice.kind === 'summary' ? 'play.systemContext.history' : 'play.systemContext.assessment')}</span>
      </header>
      {notice.kind === 'summary' ? <>
        <p className={styles.hint}>{t('play.systemContext.summaryHint')}</p>
        <div className={styles.preview}><MarkdownHtml text={notice.sections[0].body} /></div>
        <details className={styles.sections}>
          <summary>{t('play.systemContext.expand')}</summary>
          {notice.sections.map((section, index) => (
            <section key={index} className={styles.section}>
              <h3>{t(`play.systemContext.${section.id}`)}</h3>
              <MarkdownHtml className="chat-bubble__md" text={section.body} />
            </section>
          ))}
        </details>
      </> : <>
        <p className={styles.decision}>{t(`play.systemContext.${notice.action}`)}</p>
        {notice.score ? <p className={styles.hint}>{t('play.systemContext.score', { score: notice.score })}</p> : null}
      </>}
      <details className={styles.raw}>
        <summary>{t('play.systemContext.raw')}</summary>
        <pre>{notice.raw}</pre>
      </details>
    </article>
  );
}

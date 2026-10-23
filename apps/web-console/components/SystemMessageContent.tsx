'use client';
import { useI18n } from '@/lib/i18n';
import { classifySystemMessage } from '@/lib/system-message-kind';
import { parseSystemContextNotice } from '@/lib/system-context-notice';
import { parseRiskAdvisory } from '@/lib/risk-advisory';
import { presentGoalUpdate, type GoalUpdateScope } from '@/lib/goal-update-notice';
import { SystemContextCard } from './SystemContextCard';
import { RiskAdvisoryCard } from './RiskAdvisoryCard';
import { GoalUpdateCard } from './GoalUpdateCard';
import styles from './SystemMessageContent.module.css';

/** Shared by historical, immediate and structured system-text renderers. */
export function SystemMessageContent({ text, scope }: { text: string; scope?: GoalUpdateScope }) {
  const { t } = useI18n();
  const goal = presentGoalUpdate(text, scope);
  if (goal.kind === 'hidden') return null;
  const context = parseSystemContextNotice(text);
  if (context) return <SystemContextCard notice={context} />;
  const risk = parseRiskAdvisory(text);
  if (risk) return <RiskAdvisoryCard notice={risk} />;
  const notice = classifySystemMessage(text);
  return (
    <div className={`${styles.card} ${notice.warning ? styles.warning : ''}`} data-testid="system-notice-card" data-kind={goal.kind === 'card' ? 'goalUpdate' : notice.kind}>
      {goal.kind === 'card' ? <div className={styles.goal}><GoalUpdateCard notice={goal.notice} /></div> : <>
        <strong>{t(`play.systemNotice.${notice.kind}`)}</strong>
        <p className={styles.hint}>{t(`play.systemNotice.${notice.kind}Hint`)}</p>
        <p className={styles.preview}>{text.length > 240 ? `${text.slice(0, 240)}…` : text}</p>
      </>}
      <details>
        <summary>{t('play.systemNotice.details')}</summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

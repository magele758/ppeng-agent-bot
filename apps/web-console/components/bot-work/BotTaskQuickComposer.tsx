'use client';

import { useId } from 'react';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import styles from './bot-team-work.module.css';

interface SourceDeliveryRef {
  taskId: string;
  attempt: number;
}

interface BotTaskQuickComposerProps {
  bots: BotInfo[];
  target: string;
  input: string;
  busy: boolean;
  sourceDelivery: SourceDeliveryRef | null;
  onTargetChange: (value: string) => void;
  onInputChange: (value: string) => void;
  onClearSource: () => void;
  onSubmit: () => void;
}

export function BotTaskQuickComposer({
  bots,
  target,
  input,
  busy,
  sourceDelivery,
  onTargetChange,
  onInputChange,
  onClearSource,
  onSubmit,
}: BotTaskQuickComposerProps) {
  const { t } = useI18n();
  const targetId = useId();
  const inputId = useId();

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {sourceDelivery && (
        <p role="status" className={styles.sourceChip}>
          <span>
            {t('botWork.usingVersion', {
              task: sourceDelivery.taskId,
              attempt: sourceDelivery.attempt,
            })}
          </span>
          <button type="button" className={styles.ghostBtn} onClick={onClearSource}>
            {t('botWork.clearVersion')}
          </button>
        </p>
      )}
      <div className={styles.composerRow}>
        <label htmlFor={targetId} className={styles.srOnly}>
          {t('botWork.target')}
        </label>
        <select
          id={targetId}
          required
          aria-label={t('botWork.target')}
          className={styles.composerSelect}
          value={target}
          onChange={(event) => onTargetChange(event.target.value)}
        >
          <option value="">{t('botWork.notSelected')}</option>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>

        <label htmlFor={inputId} className={styles.srOnly}>
          {t('botWork.prompt')}
        </label>
        <textarea
          id={inputId}
          rows={1}
          required
          aria-label={t('botWork.prompt')}
          placeholder={t('botWork.quickDispatchPlaceholder')}
          className={styles.composerTextarea}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
        />

        <button type="submit" className={styles.primaryBtn} disabled={busy}>
          {t('botWork.assign')}
        </button>
      </div>
    </form>
  );
}

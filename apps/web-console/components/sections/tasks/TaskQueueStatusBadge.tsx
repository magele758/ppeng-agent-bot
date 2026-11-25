'use client';

import { useI18n } from '@/lib/i18n';
import { statusLabelKeyOf, statusToneOf, type StatusTone } from './task-queue-ui-helpers';
import styles from './task-queue.module.css';

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  danger: styles.badgeDanger,
  active: styles.badgeActive,
  warn: styles.badgeWarn,
  ok: styles.badgeOk,
  neutral: styles.badgeNeutral
};

export function TaskQueueStatusBadge({ status }: { status: string | undefined }) {
  const { t } = useI18n();
  if (!status) return null;
  const labelKey = statusLabelKeyOf(status);
  const tone = statusToneOf(status);
  return <span className={`${styles.badge} ${TONE_CLASS[tone]}`}>{labelKey ? t(labelKey) : status}</span>;
}

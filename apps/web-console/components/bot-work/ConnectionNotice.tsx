'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';

export function ConnectionNotice({ disconnected, lastUpdatedAt, testId, className, messageKey = 'botWork.connectionUnconfirmed' }: {
  disconnected: boolean;
  lastUpdatedAt: string | null;
  testId: string;
  className?: string;
  messageKey?: MessageKey;
}) {
  const { t, locale } = useI18n();
  if (!disconnected) return null;
  return (
    <p className={className} role="status" data-testid={testId}>
      {t(messageKey)}{' '}
      {lastUpdatedAt
        ? <>{t('botWork.lastUpdated')} <time dateTime={lastUpdatedAt}>{new Date(lastUpdatedAt).toLocaleString(locale)}</time></>
        : t('botWork.noSnapshot')}
    </p>
  );
}

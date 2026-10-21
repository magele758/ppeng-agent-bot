'use client';

import { useI18n } from '@/lib/i18n';

export function ConnectionNotice({ disconnected, lastUpdatedAt, testId }: {
  disconnected: boolean;
  lastUpdatedAt: string | null;
  testId: string;
}) {
  const { t, locale } = useI18n();
  if (!disconnected) return null;
  return (
    <p role="status" data-testid={testId}>
      {t('botWork.connectionUnconfirmed')}{' '}
      {lastUpdatedAt
        ? <>{t('botWork.lastUpdated')} <time dateTime={lastUpdatedAt}>{new Date(lastUpdatedAt).toLocaleString(locale)}</time></>
        : t('botWork.noSnapshot')}
    </p>
  );
}

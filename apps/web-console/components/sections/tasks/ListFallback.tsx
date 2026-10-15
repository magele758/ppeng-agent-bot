'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

/** Failed fetches show an alert. An empty success still uses the empty state. */
export function ListFallback({
  error,
  count,
  empty,
  children
}: {
  error: boolean;
  count: number;
  empty: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <>
      {error ? <p role="alert">{t('tasks.loadFailed')}</p> : null}
      {count === 0 ? (error ? null : empty) : children}
    </>
  );
}

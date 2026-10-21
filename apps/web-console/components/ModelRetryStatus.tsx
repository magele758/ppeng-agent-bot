'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { RetryProgress } from '@/lib/model-retry';

export function ModelRetryStatus({ progress }: { progress: RetryProgress }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (progress.phase !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [progress]);
  const seconds = Math.max(0, Math.ceil(((progress.delayMs ?? 0) - (now - progress.receivedAt)) / 1000));
  const key = progress.phase === 'waiting' ? 'play.retry.waiting'
    : progress.phase === 'switching' ? 'play.retry.switching' : 'play.retry.requesting';
  return <div data-testid="model-retry-progress" role="status" className="muted">
    <div>{t(key, { model: progress.model, retry: progress.retry, max: progress.maxRetries, seconds })}</div>
    <div>{t('play.retry.reason', { reason: progress.message })}</div>
  </div>;
}

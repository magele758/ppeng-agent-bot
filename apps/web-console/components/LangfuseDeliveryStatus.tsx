'use client';

import { useI18n } from '@/lib/i18n';

export interface LangfuseDeliverySnapshot {
  attempted: number;
  succeeded: number;
  failed: number;
  inFlight: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

type Translate = ReturnType<typeof useI18n>['t'];

function deliveryReason(error: string | null, t: Translate): string {
  const http = /^HTTP (\d{3})$/.exec(error ?? '');
  if (http) return t('settingsEntries.langfuse.deliveryHttp', { status: http[1] });
  return knownDeliveryReason(error, t);
}

function knownDeliveryReason(error: string | null, t: Translate): string {
  switch (error) {
    case 'network': return t('settingsEntries.langfuse.deliveryNetwork');
    case 'timeout': return t('settingsEntries.langfuse.deliveryTimeout');
    case 'invalid_response': return t('settingsEntries.langfuse.deliveryInvalidResponse');
    case 'ingestion_errors': return t('settingsEntries.langfuse.deliveryRejected');
    default: return t('settingsEntries.langfuse.deliveryNone');
  }
}

function deliveryTime(value: string | null, t: Translate): string {
  return value ?? t('settingsEntries.langfuse.deliveryNone');
}

export function LangfuseDeliveryStatus({ status, busy, onRefresh }: {
  status?: LangfuseDeliverySnapshot;
  busy: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  if (!status) return null;
  return <div className="muted small" aria-live="polite">
    <p>{t('settingsEntries.langfuse.deliveryScope')}</p>
    <p>{t('settingsEntries.langfuse.deliveryCounts', {
      attempted: status.attempted, succeeded: status.succeeded,
      failed: status.failed, inFlight: status.inFlight
    })}</p>
    <p>{t('settingsEntries.langfuse.deliveryLastSuccess', { time: deliveryTime(status.lastSuccessAt, t) })}</p>
    <p>{t('settingsEntries.langfuse.deliveryLastFailure', {
      time: deliveryTime(status.lastFailureAt, t), reason: deliveryReason(status.lastError, t)
    })}</p>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
      onClick={() => void onRefresh()}>{t('settingsEntries.langfuse.deliveryRefresh')}</button>
  </div>;
}

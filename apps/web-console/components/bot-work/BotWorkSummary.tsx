'use client';
import { useBotWorkOverview } from './BotWorkState';
import { useI18n } from '@/lib/i18n';

export function BotWorkSummary({ botId }: { botId?: string | null }) {
  const { t } = useI18n();
  const overview = useBotWorkOverview();
  const row = botId ? overview[botId] : undefined;
  if (!row) return null;
  return <span data-testid={`bot-work-summary-${botId}`}>
    {row.running > 0 && <span>{t('botWork.summaryRunning', { count: row.running })} </span>}
    {row.queued > 0 && <span>{t('botWork.summaryQueued', { count: row.queued })} </span>}
    {row.waiting > 0 && <span>{t('botWork.summaryWaiting', { count: row.waiting })} </span>}
    {row.unknown > 0 && <span>{t('botWork.summaryUnknown', { count: row.unknown })}</span>}
  </span>;
}

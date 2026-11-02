'use client';
import { useI18n } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import { BotBasics } from './BotBasics';
import './bot-settings-overview.css';

export function BotOverviewInfo({ bot, onSave }: {
  bot: BotInfo;
  onSave: (patch: { name: string; title: string; description: string }) => Promise<{ bot?: BotInfo }>;
}) {
  const { t } = useI18n();
  return <section className="bot-overview-info" aria-label={t('botSettings.basic')}>
    {bot.description && <details className="bot-settings-disclosure" data-testid="bot-description">
      <summary>{t('botSettings.description')}</summary>
      <p className="bot-overview-description">{bot.description}</p>
    </details>}
    <details className="bot-settings-disclosure" data-testid="bot-edit-basics">
      <summary>{t('botSettings.editBasics')}</summary>
      <BotBasics key={bot.id} bot={bot} onSave={onSave} />
    </details>
  </section>;
}

export function revealBotSetting(panel: HTMLElement | null, selector: string): void {
  const target = panel?.querySelector<HTMLElement>(selector);
  const disclosure = target?.closest('details');
  if (disclosure) disclosure.open = true;
  target?.scrollIntoView({ block: 'start' });
}

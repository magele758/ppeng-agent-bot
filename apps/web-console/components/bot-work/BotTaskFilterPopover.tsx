'use client';

import { useI18n, type MessageKey } from '@/lib/i18n';
import type { BotInfo } from '@/lib/types';
import type {
  BotTaskBand,
  BotTaskFacetCounts,
  BotTaskFilterState,
  BotTaskTimeRange,
} from '@/lib/bot-tasks-view';
import styles from './bot-team-work.module.css';

interface BotTaskFilterPopoverProps {
  bots: BotInfo[];
  filters: BotTaskFilterState;
  facets: BotTaskFacetCounts;
  hasActiveFilters: boolean;
  onChange: (next: Partial<BotTaskFilterState>) => void;
  onClear: () => void;
  onClose: () => void;
}

const BAND_OPTIONS: ReadonlyArray<{ value: BotTaskBand; labelKey: MessageKey }> = [
  { value: 'attention', labelKey: 'botWork.bandAttention' },
  { value: 'active', labelKey: 'botWork.bandActive' },
  { value: 'history', labelKey: 'botWork.bandHistory' },
];

const TIME_OPTIONS: ReadonlyArray<{ value: BotTaskTimeRange; labelKey: MessageKey }> = [
  { value: 'all', labelKey: 'botWork.filterTimeAll' },
  { value: 'today', labelKey: 'botWork.filterTimeToday' },
  { value: '3d', labelKey: 'botWork.filterTime3d' },
  { value: '7d', labelKey: 'botWork.filterTime7d' },
];

function pillClass(active: boolean): string {
  return active ? `${styles.filterPill} ${styles.filterPillActive}` : styles.filterPill;
}

function nextBandFilter(current: 'all' | BotTaskBand, clicked: BotTaskBand): 'all' | BotTaskBand {
  return current === clicked ? 'all' : clicked;
}

interface BotOption {
  id: string;
  name: string;
  count: number;
}

function includeBotOption(id: string, count: number, selectedBotId: string): boolean {
  return count > 0 || id === selectedBotId;
}

function collectKnownBots(
  bots: BotInfo[],
  byBot: Record<string, number>,
  selectedBotId: string,
): { rows: BotOption[]; seen: Set<string> } {
  const seen = new Set<string>();
  const rows: BotOption[] = [];
  for (const bot of bots) {
    seen.add(bot.id);
    const count = byBot[bot.id] ?? 0;
    if (includeBotOption(bot.id, count, selectedBotId)) rows.push({ id: bot.id, name: bot.name, count });
  }
  return { rows, seen };
}

function collectBotOptions(
  bots: BotInfo[],
  byBot: Record<string, number>,
  selectedBotId: string,
): BotOption[] {
  const { rows, seen } = collectKnownBots(bots, byBot, selectedBotId);
  for (const [id, count] of Object.entries(byBot)) {
    if (!seen.has(id) && includeBotOption(id, count, selectedBotId)) rows.push({ id, name: id, count });
  }
  return rows;
}

export function BotTaskFilterPopover({
  bots,
  filters,
  facets,
  hasActiveFilters,
  onChange,
  onClear,
  onClose,
}: BotTaskFilterPopoverProps) {
  const { t } = useI18n();
  const botOptions = collectBotOptions(bots, facets.byBot, filters.botId);

  return (
    <div className={styles.filterPopover} role="region" aria-label={t('botWork.filterButton')}>
      <div className={styles.filterSection}>
        <span className={styles.filterLabel}>{t('botWork.status')}</span>
        <div className={styles.pillGroup}>
          {BAND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filters.band === option.value}
              className={pillClass(filters.band === option.value)}
              onClick={() => onChange({ band: nextBandFilter(filters.band, option.value) })}
            >
              <span>{t(option.labelKey)}</span>
              <span className={styles.pillCount}>{facets.byBand[option.value]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterSection}>
        <span className={styles.filterLabel}>{t('botWork.filterTimeLabel')}</span>
        <div className={styles.pillGroup}>
          {TIME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filters.timeRange === option.value}
              className={pillClass(filters.timeRange === option.value)}
              onClick={() => onChange({ timeRange: option.value })}
            >
              <span>{t(option.labelKey)}</span>
              <span className={styles.pillCount}>{facets.byTime[option.value]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterSection}>
        <span className={styles.filterLabel}>{t('botWork.target')}</span>
        <div className={styles.pillGroup}>
          <button
            type="button"
            aria-pressed={filters.botId === ''}
            className={pillClass(filters.botId === '')}
            onClick={() => onChange({ botId: '' })}
          >
            <span>{t('botWork.filterAllBots')}</span>
            <span className={styles.pillCount}>{facets.total}</span>
          </button>
          {botOptions.map((bot) => (
            <button
              key={bot.id}
              type="button"
              aria-pressed={filters.botId === bot.id}
              className={pillClass(filters.botId === bot.id)}
              onClick={() => onChange({ botId: bot.id })}
            >
              <span>{bot.name}</span>
              <span className={styles.pillCount}>{bot.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.filterFooter}>
        {hasActiveFilters && (
          <button type="button" className={styles.ghostBtn} onClick={onClear}>
            {t('botWork.filterClear')}
          </button>
        )}
        <button type="button" className={styles.ghostBtn} onClick={onClose}>
          {t('botWork.closeDetail')}
        </button>
      </div>
    </div>
  );
}

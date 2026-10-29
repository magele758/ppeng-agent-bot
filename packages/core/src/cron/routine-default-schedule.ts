import { nextZonedCronRunAt } from './cron-next.js';

/**
 * Weekday 09:00 local. Sits inside the daytime complement of the default
 * quiet-hours window (22:00–08:00) and matches the Lab weekdays preset.
 */
export const DEFAULT_WEEKDAY_DAYTIME_CRON = '0 9 * * 1-5';

export function weekdayDaytimeSchedule(timezone: string): {
  scheduleKind: 'cron5';
  scheduleValue: string;
  nextRunAt: string;
} {
  return {
    scheduleKind: 'cron5',
    scheduleValue: DEFAULT_WEEKDAY_DAYTIME_CRON,
    nextRunAt: nextZonedCronRunAt(DEFAULT_WEEKDAY_DAYTIME_CRON, timezone).toISOString()
  };
}

/** Only recurring schedules expose and submit an expiration deadline. */
export function supportsRoutineExpiration(scheduleKind: string): boolean {
  return scheduleKind === 'cron' || scheduleKind === 'interval';
}

export function routineTimezone(timezone: string | undefined, fallback: string): string {
  return timezone ?? fallback;
}

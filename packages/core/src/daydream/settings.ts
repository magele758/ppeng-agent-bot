import type { DaydreamSettings, DaydreamDeps } from './types.js';
export function daydreamLocalDate(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
export function shiftDay(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}
export function daydreamLocalTime(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
}
export function readDaydreamSettings(deps: DaydreamDeps, botId: string): DaydreamSettings {
  const key = `bot_daydream:${botId}`;
  const stored = deps.settingsStore.getDaemonControl(key) as Partial<DaydreamSettings> | undefined;
  if (stored) {
    if ('maxChunks' in stored) {
      delete stored.maxChunks;
      deps.settingsStore.setDaemonControl(key, stored);
    }
    return stored as DaydreamSettings;
  }
  const legacy = deps.settingsStore.getDaemonControl('memory_settings') as {
    dreamerEnabled?: boolean;
  } | undefined;
  const initial: DaydreamSettings = { enabled: legacy?.dreamerEnabled !== false, timezone: deps.defaultTimezone ?? 'UTC', dailyAt: '03:00', memoryPolicy: 'auto', skillPolicy: 'propose', collaborationEnabled: true, effectiveFrom: new Date(deps.now?.() ?? Date.now()).toISOString() };
  deps.settingsStore.setDaemonControl(key, initial);
  return initial;
}
export function updateDaydreamSettings(deps: DaydreamDeps, botId: string, patch: Partial<DaydreamSettings>): DaydreamSettings {
  const old = readDaydreamSettings(deps, botId);
  const next = { ...old, ...patch, effectiveFrom: old.effectiveFrom };
  if ('maxChunks' in next) delete next.maxChunks;
  validateSettings(next);
  if (!old.enabled && next.enabled)
    next.effectiveFrom = new Date(deps.now?.() ?? Date.now()).toISOString();
  deps.settingsStore.setDaemonControl(`bot_daydream:${botId}`, next);
  return next;
}
function validatePolicy(next: DaydreamSettings): void {
  if (!['auto', 'review'].includes(next.memoryPolicy) || !['propose', 'autoPrivate'].includes(next.skillPolicy))
    throw new Error('Invalid policy');
}
function validateSettings(next: DaydreamSettings): void {
  if (typeof next.enabled !== 'boolean' || typeof next.collaborationEnabled !== 'boolean')
    throw new Error('Invalid boolean');
  new Intl.DateTimeFormat('en', { timeZone: next.timezone });
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.dailyAt))
    throw new Error('Invalid daily time');
  validatePolicy(next);
}

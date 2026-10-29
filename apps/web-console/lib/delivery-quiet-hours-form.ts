/**
 * 静默时段设置卡的表单形状。只组装既有 GET/PATCH /api/delivery/quiet-hours 的请求体，
 * 不判断当前是否处于窗口内。
 */

import { parseIntInRange } from './settings-fields.ts';

export const QUIET_HOURS_PATH = '/api/delivery/quiet-hours';
export const QUIET_HOUR_MIN = 0;
export const QUIET_HOUR_MAX = 23;

/** 未保存过时接口给出的开关和整点，仅用于卡片上的「默认」提示。 */
export const QUIET_HOURS_DEFAULTS = { enabled: false, startHour: 22, endHour: 8 } as const;

export interface QuietHoursSettings {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  updatedAt?: string;
}

export type QuietHoursDraft = {
  startHour: string;
  endHour: string;
  timezone: string;
} & Record<string, string>;

export const EMPTY_QUIET_HOURS_DRAFT: QuietHoursDraft = { startHour: '', endHour: '', timezone: '' };

export type QuietHoursWindowPatch = {
  startHour?: number;
  endHour?: number;
  timezone?: string;
};

export type QuietHoursFieldError = Partial<Record<keyof QuietHoursDraft, 'hour' | 'timezone'>>;

export interface QuietHoursSavePort {
  save: (patch: Record<string, unknown>) => Promise<boolean>;
}

export function draftFromQuietHours(settings: QuietHoursSettings): QuietHoursDraft {
  return {
    startHour: String(settings.startHour),
    endHour: String(settings.endHour),
    timezone: settings.timezone
  };
}

function takeHour(
  raw: string,
  saved: number,
  key: 'startHour' | 'endHour',
  patch: QuietHoursWindowPatch,
  errors: QuietHoursFieldError
): void {
  const parsed = parseIntInRange(raw, QUIET_HOUR_MIN, QUIET_HOUR_MAX);
  if (!parsed.ok) {
    errors[key] = 'hour';
    return;
  }
  if (parsed.value !== saved) patch[key] = parsed.value;
}

function takeTimezone(raw: string, saved: string, patch: QuietHoursWindowPatch, errors: QuietHoursFieldError): void {
  const timezone = raw.trim();
  if (!timezone) {
    errors.timezone = 'timezone';
    return;
  }
  if (timezone !== saved) patch.timezone = timezone;
}

export function hasQuietHoursFieldError(errors: QuietHoursFieldError): boolean {
  return errors.startHour !== undefined || errors.endHour !== undefined || errors.timezone !== undefined;
}

export function quietHoursWindowPatch(
  saved: QuietHoursSettings,
  draft: QuietHoursDraft
): { ok: true; patch: QuietHoursWindowPatch } | { ok: false; errors: QuietHoursFieldError } {
  const patch: QuietHoursWindowPatch = {};
  const errors: QuietHoursFieldError = {};
  takeHour(draft.startHour, saved.startHour, 'startHour', patch, errors);
  takeHour(draft.endHour, saved.endHour, 'endHour', patch, errors);
  takeTimezone(draft.timezone, saved.timezone, patch, errors);
  if (hasQuietHoursFieldError(errors)) return { ok: false, errors };
  return { ok: true, patch };
}

export function fieldMessage(code: string | undefined, message: string): string | undefined {
  if (!code) return undefined;
  return message;
}

export function quietHoursErrorText(
  errors: QuietHoursFieldError,
  text: { hour: string; timezone: string }
): Partial<Record<keyof QuietHoursDraft, string>> {
  return {
    startHour: fieldMessage(errors.startHour, text.hour),
    endHour: fieldMessage(errors.endHour, text.hour),
    timezone: fieldMessage(errors.timezone, text.timezone)
  };
}

function hasWindowChange(patch: QuietHoursWindowPatch): boolean {
  return patch.startHour !== undefined || patch.endHour !== undefined || patch.timezone !== undefined;
}

function saveWindowPatch(
  patch: QuietHoursWindowPatch,
  port: QuietHoursSavePort,
  onUnchanged?: () => void
): Promise<boolean> {
  if (!hasWindowChange(patch)) {
    onUnchanged?.();
    return Promise.resolve(true);
  }
  return port.save(patch);
}

/** 校验窗口草稿后 PATCH。非法输入只回报字段错误，不调用保存。 */
export function commitQuietHoursWindow(
  saved: QuietHoursSettings,
  draft: QuietHoursDraft,
  port: QuietHoursSavePort,
  report: (errors: QuietHoursFieldError) => void,
  onUnchanged?: () => void
): Promise<boolean> | undefined {
  const result = quietHoursWindowPatch(saved, draft);
  if (!result.ok) {
    report(result.errors);
    return undefined;
  }
  return saveWindowPatch(result.patch, port, onUnchanged);
}

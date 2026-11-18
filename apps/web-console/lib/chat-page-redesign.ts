import type { MessageKey } from './i18n/messages/types.ts';

export type SessionListWhen =
  | { kind: 'none' }
  | { kind: 'clock'; clock: string }
  | { kind: 'yesterday' }
  | { kind: 'weekday'; weekday: number }
  | { kind: 'monthDay'; month: number; day: number };

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const WEEKDAY_KEY: Record<number, MessageKey> = {
  0: 'chatPage.weekday.sun',
  1: 'chatPage.weekday.mon',
  2: 'chatPage.weekday.tue',
  3: 'chatPage.weekday.wed',
  4: 'chatPage.weekday.thu',
  5: 'chatPage.weekday.fri',
  6: 'chatPage.weekday.sat'
};

const QUIET_STATUS: Record<string, MessageKey> = {
  idle: 'chatPage.statusIdle',
  completed: 'chatPage.statusIdle',
  running: 'chatPage.statusWorking',
  waiting_approval: 'chatPage.statusWaiting',
  failed: 'chatPage.statusFailed',
  unknown: 'chatPage.statusUnknown'
};

function localDayStart(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayDistance(at: number, now: number): number {
  return Math.round((localDayStart(now) - localDayStart(at)) / 86_400_000);
}

function clockLabel(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function sessionListWhen(at: number | null, now = Date.now()): SessionListWhen {
  if (at == null) return { kind: 'none' };
  const diff = dayDistance(at, now);
  if (diff <= 0) return { kind: 'clock', clock: clockLabel(at) };
  if (diff === 1) return { kind: 'yesterday' };
  if (diff < 7) return { kind: 'weekday', weekday: new Date(at).getDay() };
  const date = new Date(at);
  return { kind: 'monthDay', month: date.getMonth() + 1, day: date.getDate() };
}

function weekdayLabel(weekday: number, t: Translate): string {
  return t(WEEKDAY_KEY[weekday] ?? 'chatPage.weekday.sun');
}

export function sessionListWhenText(when: SessionListWhen, t: Translate): string {
  if (when.kind === 'none') return '';
  if (when.kind === 'clock') return when.clock;
  if (when.kind === 'yesterday') return t('chatPage.yesterday');
  if (when.kind === 'weekday') return weekdayLabel(when.weekday, t);
  return t('chatPage.monthDay', { month: when.month, day: when.day });
}

export function reasoningFoldProps(streaming: boolean): { open?: true } {
  if (streaming) return { open: true };
  return {};
}

function quietAgent(name: string, id: string, t: Translate): { name: string; id: string } {
  return {
    name: name || t('chatPage.generalAgent'),
    id: id || 'general'
  };
}

export function quietStatusText(status: string | undefined, t: Translate): string {
  const named = status ?? 'idle';
  return t(QUIET_STATUS[named] ?? 'chatPage.statusIdle');
}

export function chatQuietLine(
  input: { botSurface: boolean; hasSession: boolean; agentId: string; agentName: string; status?: string },
  t: Translate
): string | null {
  if (input.botSurface || !input.hasSession) return null;
  const who = quietAgent(input.agentName, input.agentId, t);
  return t('chatPage.quietStatus', { name: who.name, id: who.id, state: quietStatusText(input.status, t) });
}

export function plainAgentName(agents: readonly { id: string; name?: string }[], id: string): string {
  const match = agents.find((agent) => agent.id === id);
  return match?.name?.trim() ?? '';
}

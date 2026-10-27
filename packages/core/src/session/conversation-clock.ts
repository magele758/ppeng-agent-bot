/**
 * View-only conversation clock.
 * Current time is rebuilt every model request and must not be stored.
 * Historical "today" stays anchored to the message's written time.
 */

export const CLOCK_NOTICE_MARK = '[conversation-clock]';
export const WRITTEN_AT_MARK = '[written ';

export const ABSOLUTE_DATE_SUMMARY_RULE =
  'Write every date as an absolute YYYY-MM-DD. Never write today, tomorrow, yesterday, or this week, and never write 今天, 明天, 昨天, 后天, 本周, or 下周. If a source message uses those words, resolve them against that message\'s writtenAt timestamp, not against the moment you are summarizing.';

export const HISTORY_DATE_RULE =
  'Each earlier message has a written time. Words such as today, tomorrow, yesterday, this week, 今天, 明天, 昨天, 后天, 本周, and 下周 inside that message are relative to its written time, not to now. The current date is only the conversation-clock note, which is not part of the saved history.';

const MIN_STAMP_MS = Date.UTC(2000, 0, 1);

export interface ZonedClock {
  timezone: string;
  date: string;
  time: string;
  weekday: string;
}

export interface ClockTextPart {
  type: string;
  text?: string;
}

export interface ClockMessage {
  role: string;
  createdAt: string;
  parts: ClockTextPart[];
}

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Session timezone wins. Otherwise the runtime's local zone, then UTC. */
export function resolveConversationTimezone(metadata?: Record<string, unknown> | null): string {
  const raw = metadata && typeof metadata.timezone === 'string' ? metadata.timezone.trim() : '';
  if (raw && isValidTimeZone(raw)) return raw;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local && isValidTimeZone(local) ? local : 'UTC';
}

export function zonedClock(nowMs: number, timezone: string): ZonedClock {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hourCycle: 'h23'
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  return {
    timezone: zone,
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    weekday: parts.find((part) => part.type === 'weekday')?.value ?? ''
  };
}


export function conversationClockNotice(nowMs: number, timezone: string): string {
  const clock = zonedClock(nowMs, timezone);
  return `${CLOCK_NOTICE_MARK} Current time: ${clock.date} ${clock.time} ${clock.weekday} (${clock.timezone}). This is the only current date. ${HISTORY_DATE_RULE} Answer date questions from this clock.`;
}

export function formatWrittenAt(createdAt: string, timezone: string): string | undefined {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < MIN_STAMP_MS) return undefined;
  const clock = zonedClock(ms, timezone);
  return `${clock.date} ${clock.time} ${clock.timezone}`;
}

function stampParts<T extends ClockTextPart>(parts: readonly T[], label: string): T[] {
  let stamped = false;
  const next = parts.map((part) => {
    if (stamped || part.type !== 'text' || typeof part.text !== 'string') return part;
    if (!part.text.trim() || part.text.includes(WRITTEN_AT_MARK) || part.text.includes(CLOCK_NOTICE_MARK)) {
      stamped = true;
      return part;
    }
    stamped = true;
    return { ...part, text: `${label}\n${part.text}` };
  });
  if (stamped) return next;
  return [{ type: 'text', text: label } as T, ...parts];
}

/** Copy. Prefix user and assistant text with the time that message was written. */
export function stampWrittenAt<T extends ClockMessage>(messages: readonly T[], timezone: string): T[] {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  return messages.map((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return message;
    const formatted = formatWrittenAt(message.createdAt, zone);
    if (!formatted) return message;
    return { ...message, parts: stampParts(message.parts, `${WRITTEN_AT_MARK}${formatted}]`) };
  });
}

/** Copy. Attach the live clock to the latest user message. Does not invent a user turn. */
export function appendClockNotice<T extends ClockMessage>(
  messages: readonly T[],
  nowMs: number,
  timezone: string
): T[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return messages.slice();
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const notice = conversationClockNotice(nowMs, zone);
  return messages.map((message, index) => {
    if (index !== lastUser) return message;
    if (message.parts.some((part) => part.type === 'text' && part.text?.includes(CLOCK_NOTICE_MARK))) return message;
    return { ...message, parts: [...message.parts, { type: 'text', text: notice }] };
  });
}

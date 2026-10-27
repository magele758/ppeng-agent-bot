/**
 * When to show the one-line session recap above the composer.
 * The line itself is written by the model from the latest turns.
 * It is not a transcript message and is never sent back into the chat.
 * Automatic display: at least three completed turns, three minutes since
 * the last turn, a return after being away, and not twice for the same progress.
 */

export const SESSION_RECAP_MAX_CHARS = 400;
export const SESSION_RECAP_MIN_TURNS = 3;
export const SESSION_RECAP_AWAY_MS = 3 * 60 * 1000;

export type RecapLocale = 'zh' | 'en';

export type RecapPart = {
  type?: string;
  text?: string;
  name?: string;
  toolCallId?: string;
  ok?: boolean;
  input?: Record<string, unknown> | null;
};

export type RecapMessage = {
  id?: string;
  role?: string;
  hidden?: boolean;
  createdAt?: string;
  parts?: readonly RecapPart[] | null;
};

export type SessionRecap = {
  anchorId: string;
  completedTurns: number;
  lastActivityAt: string | null;
};

type Turn = {
  userText: string;
  assistantText: string;
  assistantId: string;
  assistantAt: string | null;
};

export function seenRecordKey(sessionId: string): string {
  return `lab.sessionRecapSeen.${sessionId}`;
}

export function activityRecordKey(sessionId: string): string {
  return `lab.sessionRecapActivity.${sessionId}`;
}

export function isRecapCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^\/recap$/i.test(trimmed) || /^\/回顾$/.test(trimmed);
}

/** False means the composer should show a recap instead of sending. */
export function recapCommandShouldSend(text: string, hasAttachments: boolean): boolean {
  if (hasAttachments) return true;
  return !isRecapCommand(text);
}

export function resolveLastActivityMs(input: {
  messageAt?: string | null;
  sessionUpdatedAt?: string | null;
  observedAt?: number | null;
}): number | null {
  const messageAt = parseTime(input.messageAt);
  if (messageAt != null) return messageAt;
  if (typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)) return input.observedAt;
  return parseTime(input.sessionUpdatedAt);
}

/** A stored seen-anchor wins. An empty in-memory value must not forget it. */
export function resolveSeenAnchor(stored: string | null, memory: string | null): string | null {
  return stored || memory || null;
}

export function parseActivityRecord(raw: string | null, anchorId: string): number | null {
  if (!raw || !anchorId) return null;
  try {
    const parsed = JSON.parse(raw) as { anchorId?: unknown; at?: unknown };
    if (parsed.anchorId !== anchorId || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    return parsed.at;
  } catch {
    return null;
  }
}

export function buildSessionRecap(messages: readonly RecapMessage[]): SessionRecap | null {
  const turns = completedTurns(messages);
  const latest = turns[turns.length - 1];
  if (!latest) return null;
  return {
    anchorId: latest.assistantId || stableId(latest.assistantText),
    completedTurns: turns.length,
    lastActivityAt: latest.assistantAt
  };
}

export function armAutomaticRecap(input: {
  enabled: boolean;
  completedTurns: number;
  seenAnchorId: string | null;
  anchorId: string | null;
  now: number;
  lastActivityMs: number | null;
  awayStartedMs: number | null;
  arriving: boolean;
}): boolean {
  if (!input.enabled || input.completedTurns < SESSION_RECAP_MIN_TURNS) return false;
  if (!input.anchorId || input.seenAnchorId === input.anchorId) return false;
  if (input.lastActivityMs == null || input.now - input.lastActivityMs < SESSION_RECAP_AWAY_MS) return false;
  if (input.arriving) return true;
  return input.awayStartedMs != null && input.now - input.awayStartedMs >= SESSION_RECAP_AWAY_MS;
}

export function presentSessionRecap(input: {
  enabled: boolean;
  recap: SessionRecap | null;
  armed: boolean;
  manual: boolean;
  generating: boolean;
  draft: string;
  seenAnchorId: string | null;
  /** Model line. Empty while it is still being written or the call failed. */
  line: string;
}): { show: boolean; markSeen: boolean; text: string } {
  const recap = input.recap;
  const manualShow = Boolean(input.manual && recap && recap.completedTurns >= 1 && !input.generating);
  const autoShow = Boolean(
    input.armed &&
      input.enabled &&
      recap &&
      recap.completedTurns >= SESSION_RECAP_MIN_TURNS &&
      !input.generating &&
      !input.draft.trim()
  );
  const show = manualShow || autoShow;
  const text = show ? capLine(input.line) : '';
  const unseen = Boolean(recap && input.seenAnchorId !== recap.anchorId);
  return {
    show,
    markSeen: Boolean(text) && unseen,
    text
  };
}

function completedTurns(messages: readonly RecapMessage[]): Turn[] {
  const turns: Turn[] = [];
  let pendingUser: string | null = null;
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) pendingUser = text;
      continue;
    }
    if (message.role === 'assistant' && pendingUser) {
      const text = messageText(message);
      if (!text) continue;
      turns.push({
        userText: pendingUser,
        assistantText: text,
        assistantId: typeof message.id === 'string' ? message.id : '',
        assistantAt: typeof message.createdAt === 'string' ? message.createdAt : null
      });
      pendingUser = null;
    }
  }
  return turns;
}

function messageText(message: RecapMessage): string {
  const lines: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push(part.text.trim());
  }
  return lines.join('\n').trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function capLine(line: string): string {
  const chars = Array.from(oneLine(line));
  if (chars.length <= SESSION_RECAP_MAX_CHARS) return chars.join('');
  const cut = chars.slice(0, SESSION_RECAP_MAX_CHARS - 1).join('');
  const pivot = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('；'), cut.lastIndexOf('。'), cut.lastIndexOf(';'));
  const base = pivot > 200 ? cut.slice(0, pivot) : cut;
  return `${base.trimEnd()}…`;
}

function stableId(text: string): string {
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

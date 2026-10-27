/**
 * One-line session recap for the person, shown above the composer.
 * It is not a transcript message and is never sent to the model.
 * Automatic display follows the Claude Code away-summary rules:
 * at least three completed turns, three minutes since the last turn,
 * a return after being away, and not twice for the same progress.
 */

export const SESSION_RECAP_MAX_CHARS = 400;
export const SESSION_RECAP_MIN_TURNS = 3;
export const SESSION_RECAP_AWAY_MS = 3 * 60 * 1000;

const FILE_TOOLS = new Set(['write_file', 'edit_file']);
const THIN_USER =
  /^(继续|接着做?|下一步|好|好的|嗯|行|可以|ok|okay|yes|y|continue|go on|lgtm|收到)[.。!！]?$/i;
const OPEN_MARK =
  /还没|尚未|未完成|还缺|待补|待办|下一步|仍未|没补|还要|missing|still (?:missing|need|open)|not yet|remaining|\bTODO\b|\bTBD\b|待写/i;

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
  text: string;
  intent: string;
  files: string[];
  pending: string;
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

export function buildSessionRecap(
  messages: readonly RecapMessage[],
  locale: RecapLocale
): SessionRecap | null {
  const turns = completedTurns(messages);
  if (turns.length === 0) return null;
  const files = changedFiles(messages);
  const latest = turns[turns.length - 1]!;
  const intent = latestIntent(turns);
  const pending = openItem(latest.assistantText);
  const text = capLine(formatRecap(locale, intent, files, pending));
  if (!text) return null;
  return {
    anchorId: latest.assistantId || stableId(`${intent}\n${latest.assistantText}`),
    text,
    intent,
    files,
    pending,
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
  const unseen = Boolean(recap && input.seenAnchorId !== recap.anchorId);
  return {
    show,
    markSeen: show && unseen,
    text: show && recap ? recap.text : ''
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

function latestIntent(turns: readonly Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = oneLine(turns[i]!.userText);
    if (!text || isRecapCommand(text)) continue;
    if (i < turns.length - 1 && THIN_USER.test(text)) continue;
    return clipChars(text, 80);
  }
  return clipChars(oneLine(turns[turns.length - 1]?.userText ?? ''), 80);
}

function changedFiles(messages: readonly RecapMessage[]): string[] {
  const failed = new Set<string>();
  for (const message of messages) {
    if (message.hidden) continue;
    for (const part of message.parts ?? []) {
      if (part.type === 'tool_result' && part.ok === false && part.toolCallId) failed.add(part.toolCallId);
    }
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.hidden || message.role !== 'assistant') continue;
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool_call' || !part.name || !FILE_TOOLS.has(part.name)) continue;
      if (part.toolCallId && failed.has(part.toolCallId)) continue;
      const path = filePathOf(part.input);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

function filePathOf(input: RecapPart['input']): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function openItem(assistantText: string): string {
  const sentences = oneLine(assistantText)
    .split(/(?<=[。！？!?])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const marked = sentences.find((sentence) => OPEN_MARK.test(sentence));
  if (marked) return clipChars(marked, 160);
  const question = [...sentences].reverse().find((sentence) => /[?？]$/.test(sentence));
  return question ? clipChars(question, 160) : '';
}

function formatRecap(locale: RecapLocale, intent: string, files: string[], pending: string): string {
  const names = files.slice(0, 3).map((path) => clipChars(baseName(path), 40));
  const nameList = files.length > 3 ? `${names.join(locale === 'zh' ? '、' : ', ')}…` : names.join(locale === 'zh' ? '、' : ', ');
  if (locale === 'en') {
    const doing = intent ? `Recap: you were ${intent}` : 'Recap: this session';
    const edited = files.length ? ` Edited ${files.length} file${files.length === 1 ? '' : 's'}${nameList ? ` (${nameList})` : ''}.` : '';
    const left = pending ? ` ${pending}` : '';
    return `${doing}.${edited}${left}`.replace(/\.\./g, '.').replace(/\s+/g, ' ').trim();
  }
  const doing = intent ? `回顾：你在${intent}` : '回顾：这场会话';
  const edited = files.length ? `改了 ${files.length} 个文件${nameList ? `（${nameList}）` : ''}` : '';
  if (edited && pending) return `${doing}。${edited}；${pending}`.replace(/\s+/g, ' ').trim();
  if (edited) return `${doing}。${edited}。`.replace(/。。$/g, '。').replace(/\s+/g, ' ').trim();
  if (pending) return `${doing}。${pending}`.replace(/\s+/g, ' ').trim();
  return `${doing}。`;
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

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('').trimEnd();
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

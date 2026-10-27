/**
 * One-line session recap written by the model from the latest few turns.
 * A failed or empty completion is not cached and is not replaced with a
 * local splice of the user's message.
 */

export const SESSION_RECAP_MAX_CHARS = 400;
export const SESSION_RECAP_RECENT_TURNS = 4;
export const SESSION_RECAP_CACHE_KEY = 'sessionRecap';
const CLIP_CHARS = 500;

export type RecapLocale = 'zh' | 'en';

export type RecapCache = {
  anchorId: string;
  locale: RecapLocale;
  text: string;
};

export type RecapCompleteInput = {
  system: string;
  user: string;
  signal?: AbortSignal;
  jsonMode?: boolean;
};

export type RecapSourcePart = {
  type?: string;
  text?: string;
  name?: string;
  toolCallId?: string;
  ok?: boolean;
  input?: Record<string, unknown> | null;
};

export type RecapSourceMessage = {
  id?: string;
  role?: string;
  hidden?: boolean;
  parts?: readonly RecapSourcePart[] | null;
};

type Turn = {
  userText: string;
  assistantText: string;
  assistantId: string;
  files: string[];
};

const FILE_TOOLS = new Set(['write_file', 'edit_file']);

export function recapLocale(value: unknown): RecapLocale | null {
  if (value == null || value === '') return 'zh';
  if (value === 'zh' || value === 'en') return value;
  return null;
}

export function readSessionRecapCache(metadata: Record<string, unknown> | null | undefined): RecapCache | null {
  const raw = metadata?.[SESSION_RECAP_CACHE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.anchorId !== 'string' || !record.anchorId) return null;
  if (record.locale !== 'zh' && record.locale !== 'en') return null;
  if (typeof record.text !== 'string' || !record.text.trim()) return null;
  return { anchorId: record.anchorId, locale: record.locale, text: record.text };
}

/** Same anchor as the Lab: the assistant message that closed the latest turn. */
export function recapAnchorId(messages: readonly RecapSourceMessage[]): string | null {
  const turns = completedTurns(messages);
  const latest = turns[turns.length - 1];
  if (!latest) return null;
  return latest.assistantId || stableId(latest.assistantText);
}

export function buildRecapRequest(
  messages: readonly RecapSourceMessage[],
  locale: RecapLocale
): { system: string; user: string; anchorId: string } | null {
  const turns = completedTurns(messages);
  const latest = turns[turns.length - 1];
  if (!latest) return null;
  const recent = turns.slice(-SESSION_RECAP_RECENT_TURNS);
  return {
    system: systemPrompt(locale),
    user: recent.map((turn) => turnBlock(turn, locale)).join('\n\n'),
    anchorId: latest.assistantId || stableId(latest.assistantText)
  };
}

export function normalizeRecapLine(raw: string): string {
  let line = raw.trim();
  if (
    (line.startsWith('"') && line.endsWith('"') && line.length >= 2) ||
    (line.startsWith('「') && line.endsWith('」') && Array.from(line).length >= 2) ||
    (line.startsWith('“') && line.endsWith('”') && Array.from(line).length >= 2)
  ) {
    line = line.slice(1, -1).trim();
  }
  line = line.replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('{') || line.startsWith('[') || line.startsWith('```')) return '';
  const chars = Array.from(line);
  if (chars.length <= SESSION_RECAP_MAX_CHARS) return chars.join('');
  return `${chars.slice(0, SESSION_RECAP_MAX_CHARS - 1).join('').trimEnd()}…`;
}

export async function composeSessionRecap(input: {
  messages: readonly RecapSourceMessage[];
  locale: RecapLocale;
  completeText: (request: RecapCompleteInput) => Promise<string>;
  cached?: RecapCache | null;
  signal?: AbortSignal;
}): Promise<{ text: string | null; anchorId: string | null; cache: RecapCache | null }> {
  const request = buildRecapRequest(input.messages, input.locale);
  if (!request) return { text: null, anchorId: null, cache: null };
  const cached = input.cached;
  if (cached && cached.anchorId === request.anchorId && cached.locale === input.locale) {
    const text = normalizeRecapLine(cached.text);
    if (text) return { text, anchorId: request.anchorId, cache: { ...cached, text } };
  }
  let raw = '';
  try {
    raw = await input.completeText({
      system: request.system,
      user: request.user,
      signal: input.signal,
      jsonMode: false
    });
  } catch {
    return { text: null, anchorId: request.anchorId, cache: null };
  }
  const text = normalizeRecapLine(typeof raw === 'string' ? raw : '');
  if (!text) return { text: null, anchorId: request.anchorId, cache: null };
  return {
    text,
    anchorId: request.anchorId,
    cache: { anchorId: request.anchorId, locale: input.locale, text }
  };
}

function systemPrompt(locale: RecapLocale): string {
  if (locale === 'en') {
    return 'Write one recap line for someone who just returned to this conversation. Use only the latest turns below and say where things just got to. You may mention what is still open. Do not title the line with the user\'s raw message, do not start with "Recap: you were", and do not count how many files changed. No JSON, no Markdown, no line breaks. At most 400 characters. If the latest turns show no progress, reply with an empty line.';
  }
  return '你在给刚回到这场对话的人写一行回顾。只根据下面最近几轮，用一句话说明刚刚做到哪了。可以提到还没做完的事。不要把用户原话当成标题，不要以「回顾：你在」开头，不要写改了几个文件。不要 JSON，不要 Markdown，不要换行。不超过 400 字。看不出进展时只回复空行。';
}

function turnBlock(turn: Turn, locale: RecapLocale): string {
  const lines = [
    `${locale === 'zh' ? '用户' : 'user'}: ${clip(turn.userText, CLIP_CHARS)}`,
    `${locale === 'zh' ? '助手' : 'assistant'}: ${clip(turn.assistantText, CLIP_CHARS)}`
  ];
  if (turn.files.length) {
    lines.push(`${locale === 'zh' ? '文件' : 'files'}: ${clip(turn.files.join(locale === 'zh' ? '、' : ', '), CLIP_CHARS)}`);
  }
  return lines.join('\n');
}

function completedTurns(messages: readonly RecapSourceMessage[]): Turn[] {
  const failed = failedToolIds(messages);
  const turns: Turn[] = [];
  let pendingUser: string | null = null;
  let files: string[] = [];
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) {
        pendingUser = text;
        files = [];
      }
      continue;
    }
    files = mergeFiles(files, filesIn(message, failed));
    if (message.role === 'assistant' && pendingUser) {
      const text = messageText(message);
      if (!text) continue;
      turns.push({
        userText: pendingUser,
        assistantText: text,
        assistantId: typeof message.id === 'string' ? message.id : '',
        files
      });
      pendingUser = null;
      files = [];
    }
  }
  return turns;
}

function failedToolIds(messages: readonly RecapSourceMessage[]): Set<string> {
  const failed = new Set<string>();
  for (const message of messages) {
    if (message.hidden) continue;
    for (const part of message.parts ?? []) {
      if (part.type === 'tool_result' && part.ok === false && part.toolCallId) failed.add(part.toolCallId);
    }
  }
  return failed;
}

function filesIn(message: RecapSourceMessage, failed: Set<string>): string[] {
  if (message.role !== 'assistant' && message.role !== 'tool') return [];
  const files: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type !== 'tool_call' || !part.name || !FILE_TOOLS.has(part.name)) continue;
    if (part.toolCallId && failed.has(part.toolCallId)) continue;
    const path = filePathOf(part.input);
    if (path) files.push(path);
  }
  return files;
}

function mergeFiles(current: string[], found: string[]): string[] {
  const seen = new Set(current);
  const next = [...current];
  for (const path of found) {
    if (seen.has(path)) continue;
    seen.add(path);
    next.push(path);
  }
  return next;
}

function filePathOf(input: RecapSourcePart['input']): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function messageText(message: RecapSourceMessage): string {
  const lines: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push(part.text.trim());
  }
  return lines.join('\n').trim();
}

function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

function stableId(text: string): string {
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
}

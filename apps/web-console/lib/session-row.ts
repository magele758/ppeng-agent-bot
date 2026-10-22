import { botForCanonicalSession, isSidebarForkChild } from './bots.ts';
import type { BotInfo } from './types.ts';

/** Memory appendix is injected beside the user turn; it is not the question they asked. */
const MEMORY_APPENDIX_MARK = '本轮相关记忆与用户背景';
/** Dragged file bodies are untrusted data, not the question the user typed. */
const EXTERNAL_FENCE = /«external [\s\S]*?«end external»/g;

function partText(part: { type?: string; text?: string } | undefined): string {
  if (!part || part.type !== 'text' || typeof part.text !== 'string') return '';
  return part.text;
}

function questionLine(part: { type?: string; text?: string } | undefined): string {
  const text = partText(part).replace(EXTERNAL_FENCE, ' ');
  if (!text.trim() || text.includes(MEMORY_APPENDIX_MARK)) return '';
  return oneLineQuestion(text);
}

export type QuestionMessage = {
  role?: string;
  parts?: ReadonlyArray<{ type?: string; text?: string }>;
};

export type SessionRowSession = {
  id: string;
  title?: string;
  agentId?: string;
  mode?: string;
  parentSessionId?: string | null;
  metadata?: Record<string, unknown>;
};

export type BotSessionRowCopy = {
  kind: 'bot';
  title: string;
  subtitle: string;
  hasQuestion: boolean;
  /** Name passed to the living face. Empty when the roster has no name. */
  faceName: string;
};

export type PlainSessionRowCopy = {
  kind: 'plain';
  title: string;
};

export type ChildTaskSessionRowCopy = {
  kind: 'child-task';
  title: string;
  /** Roster name, readable bot title, or a short mark. Never a raw long id. */
  ownerName: string;
};

export function oneLineQuestion(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function stripBotChatPrefix(title: string): string {
  return title.replace(/^Bot Chat\s*[·•.\-]\s*/i, '').trim();
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Generated bot ids (`bot_` + hex) and bare hex blobs. Short slugs stay readable. */
const OPAQUE_LONG_ID = /^(?:bot_)?[0-9a-f]{16,}$/i;

function isOpaqueLongId(value: string): boolean {
  return OPAQUE_LONG_ID.test(value.trim());
}

function readableBotMark(value: string): string {
  const text = value.trim();
  if (!text || isOpaqueLongId(text)) return '';
  return text;
}

function shortBotMark(botId: string): string {
  const id = botId.trim();
  if (!id) return '';
  if (isOpaqueLongId(id)) return id.replace(/^bot_/i, '').slice(0, 4).toUpperCase();
  if (id.length > 24) return id.slice(0, 8);
  return id;
}

/** A forked child task, not the bot's own canonical chat and not a group room. */
export function isChildTaskSession(session: SessionRowSession, bots: readonly BotInfo[]): boolean {
  if (metadataString(session.metadata, 'roomId')) return false;
  return isSidebarForkChild(session, bots);
}

function childTaskTitle(session: SessionRowSession, unnamed: string): string {
  const title = stripBotChatPrefix(session.title ?? '');
  const botId = metadataString(session.metadata, 'botId');
  if (!title || title === botId || title === session.id) return unnamed;
  return title;
}

function childTaskOwnerName(session: SessionRowSession, bots: readonly BotInfo[], unnamed: string): string {
  const botId = metadataString(session.metadata, 'botId');
  const bot = botId ? bots.find((item) => item.id === botId) : undefined;
  const named = readableBotMark(bot?.name ?? '') || readableBotMark(bot?.title ?? '');
  if (named) return named;
  const short = shortBotMark(botId);
  if (short && short !== session.id) return short;
  return unnamed;
}

/** A single-bot chat row. Group rooms and ordinary sessions stay on the plain title. */
export function isSingleBotChat(session: SessionRowSession, bots: readonly BotInfo[]): boolean {
  if (metadataString(session.metadata, 'roomId')) return false;
  if (botForCanonicalSession(bots, session.id, [session])) return true;
  return session.metadata?.canonicalBotChat === true && metadataString(session.metadata, 'botId').length > 0;
}

/** Roster name, else the title with the Bot Chat prefix removed. Never the raw id. */
export function botRowTitle(session: SessionRowSession, bots: readonly BotInfo[]): string {
  const match = botForCanonicalSession(bots, session.id, [session]);
  const named = match?.name.trim() ?? '';
  if (named) return named;
  const fromTitle = stripBotChatPrefix(session.title ?? '');
  const botId = metadataString(session.metadata, 'botId');
  if (!fromTitle || fromTitle === botId || fromTitle === (session.agentId ?? '').trim()) return '';
  return fromTitle;
}

export function lastUserQuestion(messages: readonly QuestionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const parts = message.parts ?? [];
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const line = questionLine(parts[p]);
      if (line) return line;
    }
  }
  return '';
}

/** In-flight composer text wins; a bare placeholder does not hide the previous question. */
export function displayedQuestion(
  messages: readonly QuestionMessage[],
  pending: string | null | undefined
): string {
  const pendingLine = oneLineQuestion(pending ?? '');
  if (pendingLine && pendingLine !== '…' && pendingLine !== '...') return pendingLine;
  return lastUserQuestion(messages);
}

export function botSessionSubtitle(
  question: string,
  emptyHint: string
): { subtitle: string; hasQuestion: boolean } {
  const line = oneLineQuestion(question);
  if (!line) return { subtitle: emptyHint, hasQuestion: false };
  return { subtitle: line, hasQuestion: true };
}

export function sessionRowCopy(input: {
  session: SessionRowSession;
  bots: readonly BotInfo[];
  question: string;
  emptyHint: string;
  unnamed: string;
}): BotSessionRowCopy | PlainSessionRowCopy | ChildTaskSessionRowCopy {
  if (isChildTaskSession(input.session, input.bots)) {
    return {
      kind: 'child-task',
      title: childTaskTitle(input.session, input.unnamed),
      ownerName: childTaskOwnerName(input.session, input.bots, input.unnamed)
    };
  }
  if (!isSingleBotChat(input.session, input.bots)) {
    return { kind: 'plain', title: input.session.title || input.unnamed };
  }
  const faceName = botRowTitle(input.session, input.bots);
  const { subtitle, hasQuestion } = botSessionSubtitle(input.question, input.emptyHint);
  return {
    kind: 'bot',
    title: faceName || input.unnamed,
    subtitle,
    hasQuestion,
    faceName
  };
}

/** Resolve activity ownership using the same canonical identity as the row. */
export function sessionWorkBotId(session: SessionRowSession, bots: readonly BotInfo[]): string {
  return botForCanonicalSession(bots, session.id, [session])?.id ?? metadataString(session.metadata, 'botId');
}

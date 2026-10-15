import { botForCanonicalSession } from './bots.ts';
import type { BotInfo } from './types.ts';

/** Memory appendix is injected beside the user turn; it is not the question they asked. */
const MEMORY_APPENDIX_MARK = '本轮相关记忆与用户背景';

export type QuestionMessage = {
  role?: string;
  parts?: ReadonlyArray<{ type?: string; text?: string }>;
};

export type SessionRowSession = {
  id: string;
  title?: string;
  agentId?: string;
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
      const part = parts[p];
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      if (!part.text.trim() || part.text.includes(MEMORY_APPENDIX_MARK)) continue;
      const line = oneLineQuestion(part.text);
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
}): BotSessionRowCopy | PlainSessionRowCopy {
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

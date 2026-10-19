export const REPLY_EXCERPT_MAX = 120;

export type ReplyTo = {
  messageId: string;
  botId: string;
  excerpt: string;
};

export type ReplyQuote = ReplyTo & {
  botName: string;
};

export type QuoteAuthor = 'bot' | 'user';

export type QuoteableReply = {
  messageId: string;
  botId: string;
  botName: string;
  text: string;
  author: QuoteAuthor;
};

export type ReplyQuoteMessage = {
  id?: string;
  role?: string;
  parts?: ReadonlyArray<{ type?: string; text?: string }>;
  replyTo?: unknown;
  metadata?: unknown;
};

export type ReplyQuoteMemory = {
  byId: Map<string, ReplyTo>;
  pendingText: string | null;
  pending: ReplyTo | null;
  knownIds: Set<string> | null;
};

export function replyExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= REPLY_EXCERPT_MAX) return flat;
  return flat.slice(0, REPLY_EXCERPT_MAX);
}

export function quoteFromReply(reply: QuoteableReply): ReplyQuote | null {
  switch (reply.author) {
    case 'user':
      return null;
    case 'bot':
      break;
    default: {
      const exhaustive: never = reply.author;
      return exhaustive;
    }
  }
  const messageId = reply.messageId.trim();
  const botId = reply.botId.trim();
  const excerpt = replyExcerpt(reply.text);
  if (!messageId || !botId || !excerpt) return null;
  return {
    messageId,
    botId,
    excerpt,
    botName: reply.botName.trim() || botId
  };
}

export function withReplyTo<T extends object>(body: T, quote: ReplyQuote | null): T & { replyTo?: ReplyTo } {
  if (!quote) return { ...body };
  return {
    ...body,
    replyTo: {
      messageId: quote.messageId,
      botId: quote.botId,
      excerpt: replyExcerpt(quote.excerpt)
    }
  };
}

export function readStoredReplyTo(message: unknown): ReplyTo | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as { replyTo?: unknown; metadata?: unknown };
  const metadata = record.metadata;
  const nested =
    metadata && typeof metadata === 'object' ? (metadata as { replyTo?: unknown }).replyTo : undefined;
  return parseReplyTo(record.replyTo) ?? parseReplyTo(nested);
}

export function replySourceText(parts: ReadonlyArray<{ type?: string; text?: string }> | undefined): string {
  return textFromParts(parts);
}

export function replyMessageId(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const id = (message as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

export function replyAuthorName(
  replyTo: ReplyTo | null,
  names: Readonly<Record<string, string>> | undefined
): string {
  if (!replyTo) return '';
  const name = names?.[replyTo.botId];
  return name?.trim() ? name.trim() : replyTo.botId;
}

export function emptyReplyQuoteMemory(): ReplyQuoteMemory {
  return { byId: new Map(), pendingText: null, pending: null, knownIds: null };
}

export function rememberPendingReply(
  memory: ReplyQuoteMemory,
  text: string,
  quote: ReplyQuote | null,
  knownIds: readonly string[] = []
): void {
  if (!quote) return;
  memory.pendingText = text.trim();
  memory.pending = {
    messageId: quote.messageId,
    botId: quote.botId,
    excerpt: replyExcerpt(quote.excerpt)
  };
  memory.knownIds = new Set(knownIds);
}

export function forgetPendingReply(memory: ReplyQuoteMemory): void {
  memory.pending = null;
  memory.pendingText = null;
  memory.knownIds = null;
}

export function stampReplyQuotes<T extends ReplyQuoteMessage>(
  messages: readonly T[],
  memory: ReplyQuoteMemory
): T[] {
  const pending = memory.pending;
  const pendingText = memory.pendingText;
  const known = memory.knownIds;
  let target = -1;
  if (pending && pendingText) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== 'user') continue;
      const id = typeof message.id === 'string' ? message.id : '';
      if (!id || (known?.has(id) ?? false)) continue;
      if (!textFromParts(message.parts).includes(pendingText)) continue;
      target = index;
      break;
    }
  }
  let changed = false;
  const next = messages.map((message, index) => {
    if (message.role !== 'user') return message;
    const id = typeof message.id === 'string' ? message.id : '';
    const stored = readStoredReplyTo(message);
    if (stored) {
      if (id) memory.byId.set(id, stored);
      if (index === target) forgetPendingReply(memory);
      return message;
    }
    const remembered = id ? memory.byId.get(id) : undefined;
    if (remembered) {
      changed = true;
      return { ...message, replyTo: remembered };
    }
    if (index === target && pending) {
      if (id) memory.byId.set(id, pending);
      forgetPendingReply(memory);
      changed = true;
      return { ...message, replyTo: pending };
    }
    return message;
  });
  return changed ? next : (messages as T[]);
}

export function attachSentReply<T extends object>(message: T, quote: ReplyQuote | null): T {
  if (!quote || readStoredReplyTo(message)) return message;
  return {
    ...message,
    replyTo: {
      messageId: quote.messageId,
      botId: quote.botId,
      excerpt: replyExcerpt(quote.excerpt)
    }
  };
}

export function keepLocalReplyTo<T extends { id: string }>(previous: readonly T[], incoming: readonly T[]): T[] {
  const prior = new Map<string, ReplyTo>();
  for (const message of previous) {
    const replyTo = readStoredReplyTo(message);
    if (replyTo) prior.set(message.id, replyTo);
  }
  if (prior.size === 0) return incoming as T[];
  let changed = false;
  const next = incoming.map((message) => {
    if (readStoredReplyTo(message)) return message;
    const kept = prior.get(message.id);
    if (!kept) return message;
    changed = true;
    return { ...message, replyTo: kept };
  });
  return changed ? next : (incoming as T[]);
}

function parseReplyTo(value: unknown): ReplyTo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { messageId?: unknown; botId?: unknown; excerpt?: unknown };
  if (typeof raw.messageId !== 'string' || typeof raw.botId !== 'string' || typeof raw.excerpt !== 'string') {
    return null;
  }
  const messageId = raw.messageId.trim();
  const botId = raw.botId.trim();
  const excerpt = replyExcerpt(raw.excerpt);
  if (!messageId || !botId || !excerpt) return null;
  return { messageId, botId, excerpt };
}

function textFromParts(parts: ReadonlyArray<{ type?: string; text?: string }> | undefined): string {
  if (!parts) return '';
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push(part.text);
  }
  return lines.join('\n');
}

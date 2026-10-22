import { childTasksForBot, isBotForkChildSession } from './bots.ts';
import { parseTimeMs } from './session-chrome.ts';
import { stripBotChatPrefix } from './session-row.ts';

/** Visible chip length. Long task text stays a short excerpt in the conversation. */
export const CHILD_TASK_STREAM_EXCERPT = 24;

export type ChildTaskStreamEntry = {
  id: string;
  excerpt: string;
  title: string;
  /** Parent message this task was split from, when the session recorded one. */
  sourceMessageId?: string;
  /** When the child session was created. */
  createdAt?: string;
};

export type ChildTaskFeedMessage = {
  id?: string;
  createdAt?: unknown;
};

export function childTaskStreamExcerpt(title: string, max = CHILD_TASK_STREAM_EXCERPT): string {
  const compact = stripBotChatPrefix(title ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length <= max) return compact;
  return `${chars.slice(0, max).join('').trimEnd()}…`;
}

/** The bot's own chat, not a child task and not a group room. */
export function isBotMainConversation(
  session: { id: string; metadata?: Record<string, unknown> } | null | undefined,
  bot: { id: string; canonicalSessionId?: string | null }
): boolean {
  if (!session) return false;
  if (session.metadata?.roomId) return false;
  if (isBotForkChildSession(session.metadata)) return false;
  if (bot.canonicalSessionId && session.id === bot.canonicalSessionId) return true;
  return session.metadata?.canonicalBotChat === true && session.metadata.botId === bot.id;
}

/**
 * Where each child task sits in the loaded transcript.
 * A task stays after the message it was generated from. Tasks older than this
 * page are omitted so they do not collect at the bottom.
 */
export function placeChildTaskEntries(
  messages: readonly ChildTaskFeedMessage[],
  entries: readonly ChildTaskStreamEntry[]
): Map<number, ChildTaskStreamEntry[]> {
  const idToIndex = new Map<string, number>();
  const times: Array<number | undefined> = [];
  messages.forEach((message, index) => {
    if (message.id) idToIndex.set(message.id, index);
    times.push(parseTimeMs(message.createdAt));
  });
  const grouped = new Map<number, ChildTaskStreamEntry[]>();
  for (const entry of entries) {
    const index = anchorIndex(entry, idToIndex, times);
    if (index == null) continue;
    const group = grouped.get(index);
    if (group) group.push(entry);
    else grouped.set(index, [entry]);
  }
  return grouped;
}

function anchorIndex(
  entry: ChildTaskStreamEntry,
  idToIndex: Map<string, number>,
  times: Array<number | undefined>
): number | undefined {
  if (entry.sourceMessageId) {
    const bySource = idToIndex.get(entry.sourceMessageId);
    if (bySource != null) return bySource;
  }
  const at = parseTimeMs(entry.createdAt);
  if (at == null) return undefined;
  let last = -1;
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    if (time == null || time > at) continue;
    last = index;
  }
  return last >= 0 ? last : undefined;
}

export function streamChildTaskEntries<T extends { id: string; title: string; createdAt?: string; metadata?: Record<string, unknown> }>(input: {
  surface: 'chat' | 'bot';
  sessions: readonly T[];
  bot: { id: string; canonicalSessionId?: string | null } | null | undefined;
  current: { id: string; metadata?: Record<string, unknown> } | null | undefined;
}): ChildTaskStreamEntry[] {
  if (input.surface !== 'bot' || !input.bot || !isBotMainConversation(input.current, input.bot)) return [];
  const entries: ChildTaskStreamEntry[] = [];
  for (const task of childTasksForBot(input.sessions, input.bot)) {
    const excerpt = childTaskStreamExcerpt(task.title);
    if (!excerpt) continue;
    const source = task.metadata?.sourceMessageId;
    const createdAt = task.createdAt;
    entries.push({
      id: task.id,
      excerpt,
      title: stripBotChatPrefix(task.title).replace(/\s+/g, ' ').trim(),
      ...(typeof source === 'string' && source ? { sourceMessageId: source } : {}),
      ...(typeof createdAt === 'string' && createdAt ? { createdAt } : {})
    });
  }
  return entries;
}

export const BOT_FIRST_TASK_DISMISSED_KEY = 'lab.botFirstTaskDismissed';
export const BOT_FIRST_TASK_DISMISSED_PREFIX = 'lab.botFirstTaskDismissed.';
export const BOT_FIRST_TASK_ANCHOR_KEY = 'lab.botFirstTaskAnchor';
export const BOT_FIRST_TASK_DRAFT_KEY = 'lab.botFirstTaskDraft';
export const BOT_FIRST_TASK_SENT_KEY = 'lab.botFirstTaskSent';
export const BOT_FIRST_TASK_SENT_EVENT = 'ppeng-bot-first-task-sent';

export type FirstTaskStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
};

export type BotFirstTaskPhase = 'hidden' | 'pending' | 'visible';
export type BotFirstTaskConversation = 'absent' | 'loading' | 'empty' | 'started';
export type UserMessageProbe = 'yes' | 'no' | 'unknown';

type OutreachSession = {
  id: string;
  metadata?: Record<string, unknown>;
};

type OutreachBot = {
  canonicalSessionId?: string;
};

export function readBotFirstTaskDismissed(storage: FirstTaskStorage): boolean {
  try {
    if (storage.getItem(BOT_FIRST_TASK_DISMISSED_KEY) === '1') return true;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(BOT_FIRST_TASK_DISMISSED_PREFIX) && storage.getItem(key) === '1') return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function writeBotFirstTaskDismissed(storage: FirstTaskStorage): void {
  storage.setItem(BOT_FIRST_TASK_DISMISSED_KEY, '1');
}

export function readBotFirstTaskSent(storage: FirstTaskStorage): boolean {
  try {
    return storage.getItem(BOT_FIRST_TASK_SENT_KEY) === '1';
  } catch {
    return false;
  }
}

export function readBotFirstTaskAnchor(storage: FirstTaskStorage): string | null {
  try {
    const value = storage.getItem(BOT_FIRST_TASK_ANCHOR_KEY)?.trim() ?? '';
    return value || null;
  } catch {
    return null;
  }
}

export function writeBotFirstTaskAnchor(storage: FirstTaskStorage, botId: string): void {
  storage.setItem(BOT_FIRST_TASK_ANCHOR_KEY, botId);
}

export function readBotFirstTaskDraft(storage: FirstTaskStorage, botId: string): string | null {
  try {
    const raw = storage.getItem(BOT_FIRST_TASK_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { botId?: unknown; text?: unknown };
    if (parsed.botId !== botId || typeof parsed.text !== 'string') return null;
    return parsed.text;
  } catch {
    return null;
  }
}

export function writeBotFirstTaskDraft(storage: FirstTaskStorage, botId: string, text: string): void {
  storage.setItem(BOT_FIRST_TASK_DRAFT_KEY, JSON.stringify({ botId, text }));
}

export function markBotFirstTaskSent(storage: FirstTaskStorage): void {
  storage.setItem(BOT_FIRST_TASK_SENT_KEY, '1');
  storage.removeItem(BOT_FIRST_TASK_DRAFT_KEY);
}

export function noteBotFirstTaskSent(): void {
  if (typeof window === 'undefined') return;
  try {
    markBotFirstTaskSent(window.localStorage);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(BOT_FIRST_TASK_SENT_EVENT));
}

export function historyHasUserMessage(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    return (message as { role?: unknown }).role === 'user';
  });
}

/** Canonical Bot chats, newest sessions first, then any roster session not already included. */
export function botOutreachTargets(
  sessions: readonly OutreachSession[],
  bots: readonly OutreachBot[],
  currentSessionId?: string | null
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const session of sessions) {
    if (session.metadata?.canonicalBotChat === true) add(session.id);
  }
  for (const bot of bots) add(bot.canonicalSessionId);
  add(currentSessionId);
  return ids;
}

export async function findBotUserMessage(
  ids: readonly string[],
  probe: (id: string) => Promise<UserMessageProbe>,
  cancelled: () => boolean
): Promise<UserMessageProbe> {
  if (ids.length === 0) return 'no';
  const queue = [...ids];
  let found = false;
  let unknown = false;
  const run = async () => {
    while (!found && !cancelled() && queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      const result = await probe(id);
      if (result === 'yes') found = true;
      else if (result === 'unknown') unknown = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, () => run()));
  if (found) return 'yes';
  if (cancelled() || unknown) return 'unknown';
  return 'no';
}

export function botFirstTaskPhase(input: {
  botId: string;
  conversation: BotFirstTaskConversation;
  storageReady: boolean;
  dismissed: boolean;
  sent: boolean;
  accountSent: boolean | null;
  anchorBotId: string | null;
}): BotFirstTaskPhase {
  if (!input.botId || input.conversation === 'absent') return 'hidden';
  if (!input.storageReady || input.conversation === 'loading') return 'pending';
  if (input.dismissed || input.sent || input.conversation === 'started') return 'hidden';
  if (input.anchorBotId && input.anchorBotId !== input.botId) return 'hidden';
  if (input.accountSent === null) return 'pending';
  if (input.accountSent) return 'hidden';
  return 'visible';
}

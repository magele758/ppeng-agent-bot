/** Prefix stored on canonical bot sessions (`canonicalBotChatTitle`). Header display strips it. */
export const CANONICAL_BOT_CHAT_TITLE_PREFIX = 'Bot Chat · ';

/** DOM id of the existing bot permission / allowlist block on the bot detail page. */
export const BOT_PERMISSIONS_SECTION_ID = 'bot-permissions';

export function botNameFromCanonicalTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed.startsWith(CANONICAL_BOT_CHAT_TITLE_PREFIX)) return '';
  return trimmed.slice(CANONICAL_BOT_CHAT_TITLE_PREFIX.length).trim();
}

/**
 * Chat header title.
 * Bot chats show the bot name only. Other sessions keep the session title.
 */
export function botChatHeaderTitle(input: {
  botChat: boolean;
  botName?: string | null;
  sessionTitle: string;
}): string {
  if (!input.botChat) return input.sessionTitle;
  const name = typeof input.botName === 'string' ? input.botName.trim() : '';
  if (name) return name;
  const fromTitle = botNameFromCanonicalTitle(input.sessionTitle);
  if (fromTitle) return fromTitle;
  return input.sessionTitle;
}

/** Hash that opens the existing permission settings for one bot. */
export function botPermissionsHref(botId: string): string {
  return `#/agents/bots?bot=${encodeURIComponent(botId.trim())}&focus=permissions`;
}

/** Parse a permissions deep link. Other hashes return null. */
export function readBotPermissionsTarget(hash: string): { botId: string } | null {
  const queryAt = hash.indexOf('?');
  if (queryAt < 0) return null;
  const path = hash.slice(0, queryAt).replace(/^#\/?/, '');
  if (path !== 'agents/bots') return null;
  const params = new URLSearchParams(hash.slice(queryAt + 1));
  if (params.get('focus') !== 'permissions') return null;
  const botId = (params.get('bot') ?? '').trim();
  if (!botId) return null;
  return { botId };
}

/**
 * Bot sessions keep a private memory namespace (agent_memory.agent_id).
 * Rows with a null agent id are the shared user.memory pool; schema v22 moved
 * pre-v21 rows written from bot sessions out of it.
 */

export interface BotMemorySession {
  id?: string;
  agentId?: string;
  mode?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown> | null;
}

export interface BotMemoryLookup {
  getBot?(id: string): { id?: string; agentId: string } | undefined;
  listBots?(opts?: { includeHidden?: boolean }): Array<{ id: string; agentId: string }>;
  getSession?(id: string): BotMemorySession | undefined;
}

/** Child sessions spawned by a bot share that bot's namespace. */
const INHERITING_MODES = new Set(['subagent', 'teammate']);
const MAX_PARENT_HOPS = 6;

function resolvePrivateBotAgentId(session: BotMemorySession, lookup?: BotMemoryLookup): string | undefined {
  const metaBotId =
    typeof session.metadata?.botId === 'string' ? session.metadata.botId.trim() : '';
  const sessionAgent = typeof session.agentId === 'string' ? session.agentId.trim() : '';

  if (metaBotId) {
    const bot = lookup?.getBot?.(metaBotId);
    const fromBot = bot?.agentId?.trim();
    if (fromBot) return fromBot;
    return sessionAgent || metaBotId;
  }

  if (!sessionAgent || !lookup) return undefined;
  const byId = lookup.getBot?.(sessionAgent);
  const fromId = byId?.agentId?.trim();
  if (fromId) return fromId;
  const listed = lookup.listBots?.({ includeHidden: true }) ?? [];
  const match = listed.find((bot) => bot.id === sessionAgent || bot.agentId === sessionAgent);
  return match?.agentId?.trim() || undefined;
}

function resolveOwnBotAgentId(session: BotMemorySession, lookup?: BotMemoryLookup): string | undefined {
  const bot = resolvePrivateBotAgentId(session, lookup);
  const roomId = typeof session.metadata?.roomId === 'string' ? session.metadata.roomId.trim() : '';
  return roomId && bot ? `room:${roomId}:${bot}` : bot;
}

function parentSessionIdOf(session: BotMemorySession): string {
  if (session.parentSessionId?.trim()) return session.parentSessionId.trim();
  const fromMeta = session.metadata?.parentSessionId;
  return typeof fromMeta === 'string' ? fromMeta.trim() : '';
}

/**
 * Agent id to read/write when this session is a bot.
 * A session is a bot when metadata.botId is set, or when session.agentId matches a bot.
 * Subagent / teammate sessions inherit the namespace of the bot session that spawned them.
 * Returns undefined for ordinary chats so they keep using shared user.memory.
 */
export function resolveBotMemoryAgentId(
  session: BotMemorySession,
  lookup?: BotMemoryLookup
): string | undefined {
  const visited = new Set<string>();
  if (session.id) visited.add(session.id);
  return resolveNode(session, lookup, visited, 0);
}

/**
 * A child (subagent / teammate) session's own agentId is caller-influenced (a teammate takes the
 * name the spawning model chose), so the spawning chain decides first and the session's own
 * identity is only a fallback. Non-child sessions are resolved from their own identity alone.
 */
function resolveNode(
  session: BotMemorySession,
  lookup: BotMemoryLookup | undefined,
  visited: Set<string>,
  hop: number
): string | undefined {
  const inherits = Boolean(lookup?.getSession && session.mode && INHERITING_MODES.has(session.mode));
  if (!inherits || !lookup?.getSession) return resolveOwnBotAgentId(session, lookup);

  const parentId = parentSessionIdOf(session);
  if (parentId && hop < MAX_PARENT_HOPS && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = lookup.getSession(parentId);
    if (parent) {
      const fromParent = resolveNode(parent, lookup, visited, hop + 1);
      if (fromParent) return fromParent;
    }
  }
  return resolveOwnBotAgentId(session, lookup);
}

/**
 * userId / tenantId a bot-derived child session should carry so its user-level
 * memory resolves without RAW_AGENT_DEFAULT_USER_ID. Ordinary parents return {}.
 */
export function inheritBotIdentityMetadata(
  parent: BotMemorySession,
  lookup?: BotMemoryLookup
): { userId?: string; tenantId?: string } {
  if (!resolveBotMemoryAgentId(parent, lookup)) return {};
  const out: { userId?: string; tenantId?: string } = {};
  const userId = parent.metadata?.userId;
  if (typeof userId === 'string' && userId.trim()) out.userId = userId.trim();
  const tenantId = parent.metadata?.tenantId;
  if (typeof tenantId === 'string' && tenantId.trim()) out.tenantId = tenantId.trim();
  return out;
}

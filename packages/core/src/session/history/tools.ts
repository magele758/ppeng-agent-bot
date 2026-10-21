import type { SessionMessage, ToolContract } from '../../types.js';
import { resolveBotMemoryAgentId, resolveSubagentMemoryAccess } from '../../memory/bot-memory-scope.js';
import { collectSubagentMemoryHits } from '../../memory/subagent-recall.js';
import { sharedMessageVisible } from '../../bots/shared-context-isolation.js';
import { createHistoryTools as createVisibleHistoryTools } from '../../tools/history-tools.js';
import { historyReference, sourcePage, type HistoryStore as VisibleHistoryStore } from '../history-retrieval.js';
import type { HistoryOptions, HistoryStore } from './types.js';

type ScopedHistoryStore = HistoryStore & Partial<VisibleHistoryStore>;
type ReadArgs = { ref?: string; session_id?: string; seq?: number; part?: number; offset?: number; limit?: number; before?: number; after?: number };
interface ForkSession { id: string; mode?: string; parentSessionId?: string; metadata?: Record<string, unknown> | null }
interface ForkStore extends ScopedHistoryStore {
 getBot?(id: string): { id: string; name: string; title: string; description: string; agentId: string } | undefined;
 getAgent?(id: string): { instructions?: string } | undefined;
}
const unavailable = () => ({ ok: false, content: 'Source unavailable.' });
const EMPTY_NOTICE = '没有找到';

function metaText(metadata: Record<string, unknown> | null | undefined, key: string): string {
 const value = metadata?.[key];
 return typeof value === 'string' ? value.trim() : '';
}

function parentIdOf(session: { parentSessionId?: string; metadata?: Record<string, unknown> | null }): string {
 if (session.parentSessionId?.trim()) return session.parentSessionId.trim();
 return metaText(session.metadata, 'parentSessionId');
}

function sameOwner(child: ForkSession, parent: ForkSession): boolean {
 const childUser = metaText(child.metadata, 'userId');
 const parentUser = metaText(parent.metadata, 'userId');
 const childTenant = metaText(child.metadata, 'tenantId');
 const parentTenant = metaText(parent.metadata, 'tenantId');
 if (childUser || parentUser) return childUser === parentUser && childTenant === parentTenant;
 return childTenant === parentTenant;
}

/** Parent conversation a bot fork may read. Sibling sessions and other bots stay out. */
function forkParentId(store: ForkStore, session: ForkSession): string | undefined {
 if (session.mode !== 'subagent') return undefined;
 const botId = metaText(session.metadata, 'botId');
 if (!botId) return undefined;
 const parentId = parentIdOf(session);
 if (!parentId || parentId === session.id) return undefined;
 const parent = store.getSession?.(parentId);
 if (!parent || metaText(parent.metadata, 'botId') !== botId || !sameOwner(session, parent)) return undefined;
 return parentId;
}

function readBotCharter(store: ForkStore, session: ForkSession, args: ReadArgs) {
 const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
 if (!ref.startsWith('bot:')) return undefined;
 const botId = metaText(session.metadata, 'botId');
 const requested = ref.slice('bot:'.length);
 if (!botId || (requested !== 'self' && requested !== botId)) return unavailable();
 const bot = store.getBot?.(botId);
 if (!bot || bot.id !== botId) return unavailable();
 const agent = store.getAgent?.(bot.agentId) ?? store.getAgent?.(bot.id);
 return {
  ok: true,
  content: JSON.stringify({
   botId: bot.id,
   name: bot.name,
   title: bot.title,
   description: bot.description,
   duties: typeof agent?.instructions === 'string' ? agent.instructions : bot.description
  })
 };
}

function partText(part: SessionMessage['parts'][number]): string | undefined {
 return part.type === 'text' ? part.text : part.type === 'tool_result' ? part.content : undefined;
}

function readOwnSource(store: HistoryStore, sessionId: string, args: ReadArgs) {
 if (args.session_id !== undefined && args.session_id !== sessionId) return unavailable();
 let part = args.part ?? 0;
 let message: SessionMessage | undefined;
 if (args.ref) {
  const match = /^history:([^:]+):([^:]+):(\d+)$/.exec(args.ref);
  if (!match) return unavailable();
  let target: string, id: string;
  try { target = decodeURIComponent(match[1]!); id = decodeURIComponent(match[2]!); } catch { return unavailable(); }
  if (target !== sessionId) return unavailable();
  part = Number(match[3]);
  message = store.readHistoryById?.(sessionId, id);
 } else {
  if (!Number.isSafeInteger(args.seq) || args.seq! < 1) return unavailable();
  message = store.readHistory(sessionId, args.seq!, 0, 0)?.message;
 }
 if (!message || !sharedMessageVisible(store, sessionId, message)) return unavailable();
 // Preserve seq-only and explicit original-plus-neighbours requests; ref/part/offset opt into source pages.
 const legacyContext = args.before !== undefined || args.after !== undefined
  || (!args.ref && args.part === undefined && args.offset === undefined);
 if (legacyContext) {
  if (!Number.isSafeInteger(message.seq) || message.seq! < 1) return unavailable();
  const context = store.readHistory(sessionId, message.seq!, args.before, args.after);
  return context ? { ok: true, content: JSON.stringify({ ...context, messages: context.messages.filter(item => sharedMessageVisible(store, sessionId, item)) }) } : unavailable();
 }
 if (!Number.isSafeInteger(part) || part < 0 || !message.parts[part]) return unavailable();
 const text = partText(message.parts[part]!);
 if (text === undefined) return unavailable();
 return { ok: true, content: JSON.stringify({ ref: historyReference(sessionId, message.id, part), sessionId, messageId: message.id, seq: message.seq, part, ...sourcePage(text, args.offset, args.limit) }) };
}

function searchOwnSource(store: HistoryStore, sessionId: string, args: HistoryOptions) {
 const originalPage = store.listHistory(sessionId, args);
 const page = { ...originalPage, messages: originalPage.messages.filter(message => sharedMessageVisible(store, sessionId, message)) };
 const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
 const matches: Array<Record<string, unknown>> = [];
 for (const message of page.messages) for (let part = 0; part < message.parts.length; part++) {
  const text = partText(message.parts[part]!);
  if (!text) continue;
  const at = query ? text.toLocaleLowerCase().indexOf(query) : 0;
  if (at < 0) continue;
  matches.push({ ref: historyReference(sessionId, message.id, part), sessionId, messageId: message.id, seq: message.seq, part, role: message.role, createdAt: message.createdAt, excerpt: text.slice(Math.max(0, at - 80), Math.max(0, at - 80) + 320) });
 }
 return { ok: true, content: JSON.stringify({ ...page, matches }) };
}

function historyTarget(args: ReadArgs): string | undefined {
 if (typeof args.session_id === 'string') return args.session_id;
 if (!args.ref) return undefined;
 const match = /^history:([^:]+):/.exec(args.ref);
 if (!match) return undefined;
 try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}

function searchForkSource(store: ForkStore, session: ForkSession, args: HistoryOptions & { session_id?: string }) {
 const parentId = forkParentId(store, session);
 const allowed = new Set([session.id, ...(parentId ? [parentId] : [])]);
 if (args.session_id !== undefined && !allowed.has(args.session_id)) return unavailable();
 const query = typeof args.query === 'string' ? args.query.trim() : '';
 const ids = args.session_id ? [args.session_id] : parentId && query ? [session.id, parentId] : [session.id];
 if (ids.length === 1) return searchOwnSource(store, ids[0]!, args);
 const matches: Array<Record<string, unknown>> = [];
 const messages: HistoryPageMessage[] = [];
 let hasMore = false;
 for (const id of ids) {
  const parsed = JSON.parse(searchOwnSource(store, id, args).content) as { messages?: HistoryPageMessage[]; matches?: Array<Record<string, unknown>>; hasMore?: boolean };
  messages.push(...(parsed.messages ?? []));
  matches.push(...(parsed.matches ?? []));
  if (parsed.hasMore) hasMore = true;
 }
 return { ok: true, content: JSON.stringify({ messages, matches, hasMore, nextCursor: null }) };
}

type HistoryPageMessage = { id?: string };

function readForkSource(store: ForkStore, session: ForkSession, args: ReadArgs) {
 const parentId = forkParentId(store, session);
 const target = historyTarget(args) ?? session.id;
 if (target !== session.id && target !== parentId) return unavailable();
 return readOwnSource(store, target, args);
}

/** One runtime catalog pair: ordinary identity-scoped history, isolated Bot/Room originals. */
export function createHistoryTools(store: ForkStore): ToolContract[] {
 const visible = store.getSession && store.listSessions && store.listSurfaceNodes
  ? createVisibleHistoryTools({ historyStore: store as VisibleHistoryStore }) : [];
 const search = visible.find(tool => tool.name === 'history_search');
 const read = visible.find(tool => tool.name === 'history_read');
 const scoped = (session: Parameters<ToolContract['execute']>[0]['session']) => Boolean(
  typeof session.metadata?.userId !== 'string' || !session.metadata.userId.trim()
  || session.metadata?.roomId || resolveBotMemoryAgentId(session, store)
 );
 return [{
  name: 'history_search',
  description: 'Search retained original history. Signed-in ordinary chats search sessions visible to the current identity and namespace; anonymous, Bot and Room sessions search only THIS session. A bot sub-agent also searches its parent bot conversation by keyword, plus that bot\'s notes and durable memory, and does not search sibling conversations or other bots. No keyword match is an explicit empty result. Returns stable seq/id/ref sources for history_read.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, session_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, beforeSeq: { type: 'integer' }, limit: { type: 'integer' } } },
  approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
  async execute(ctx, args) {
   try {
    const result = !scoped(ctx.session) && search ? await search.execute(ctx, args) : searchForkSource(store, ctx.session, args as HistoryOptions & { session_id?: string });
    if (!result.ok || !resolveSubagentMemoryAccess(ctx.session, store)) return result;
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const query = typeof (args as { query?: unknown }).query === 'string' ? (args as { query: string }).query : '';
    parsed.memories = collectSubagentMemoryHits(store, ctx.session, query);
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
    if (query.trim() && matches.length === 0 && memories.length === 0) {
     parsed.found = false;
     parsed.notice = EMPTY_NOTICE;
    }
    return { ok: true, content: JSON.stringify(parsed) };
   }
   catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error) }; }
  }
 }, {
  name: 'history_read',
  description: 'Read retained original evidence by ref or session_id/seq from a compression source note. part defaults to 0; offset/limit are character counts and pages are at most 12000 characters. Current-session reads by seq alone or explicit before/after return the original message and indexed neighbours. Anonymous, Bot and Room sessions can read only THIS session. A bot sub-agent can also read its parent bot conversation. ref bot:self returns that bot\'s name and duties; another bot id is refused.',
  inputSchema: { type: 'object', properties: { ref: { type: 'string' }, session_id: { type: 'string' }, seq: { type: 'integer' }, part: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, before: { type: 'integer' }, after: { type: 'integer' } } },
  approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
  async execute(ctx, args) {
   try {
    const charter = readBotCharter(store, ctx.session, args as ReadArgs);
    if (charter) return charter;
    return !scoped(ctx.session) && read ? await read.execute(ctx, args) : readForkSource(store, ctx.session, args as ReadArgs);
   }
   catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error) }; }
  }
 }];
}

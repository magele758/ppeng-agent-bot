import type { SessionMessage, ToolContract } from '../../types.js';
import { resolveBotMemoryAgentId, resolveSubagentMemoryAccess } from '../../memory/bot-memory-scope.js';
import { collectSubagentMemoryHits } from '../../memory/subagent-recall.js';
import { sharedMessageVisible } from '../../bots/shared-context-isolation.js';
import { createHistoryTools as createVisibleHistoryTools } from '../../tools/history-tools.js';
import { historyReference, sourcePage, type HistoryStore as VisibleHistoryStore } from '../history-retrieval.js';
import type { HistoryOptions, HistoryStore } from './types.js';

type ScopedHistoryStore = HistoryStore & Partial<VisibleHistoryStore>;
type ReadArgs = { ref?: string; session_id?: string; seq?: number; part?: number; offset?: number; limit?: number; before?: number; after?: number };
const unavailable = () => ({ ok: false, content: 'Source unavailable.' });

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

function searchOwnSource(store: HistoryStore, sessionId: string, args: HistoryOptions & { session_id?: string }) {
 if (args.session_id !== undefined && args.session_id !== sessionId) return unavailable();
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

/** One runtime catalog pair: ordinary identity-scoped history, isolated Bot/Room originals. */
export function createHistoryTools(store: ScopedHistoryStore): ToolContract[] {
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
  description: 'Search retained original history. Signed-in ordinary chats search sessions visible to the current identity and namespace; anonymous, Bot, Room and their child sessions search only THIS session. A bot sub-agent also receives that bot\'s parent notes and global memory. Returns stable seq/id/ref sources for history_read.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, session_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, beforeSeq: { type: 'integer' }, limit: { type: 'integer' } } },
  approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
  async execute(ctx, args) {
   try {
    const result = !scoped(ctx.session) && search ? await search.execute(ctx, args) : searchOwnSource(store, ctx.session.id, args as HistoryOptions & { session_id?: string });
    if (!result.ok || !resolveSubagentMemoryAccess(ctx.session, store)) return result;
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const query = typeof (args as { query?: unknown }).query === 'string' ? (args as { query: string }).query : '';
    parsed.memories = collectSubagentMemoryHits(store, ctx.session, query);
    return { ok: true, content: JSON.stringify(parsed) };
   }
   catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error) }; }
  }
 }, {
  name: 'history_read',
  description: 'Read retained original evidence by ref or session_id/seq from a compression source note. part defaults to 0; offset/limit are character counts and pages are at most 12000 characters. Current-session reads by seq alone or explicit before/after return the original message and indexed neighbours. Anonymous, Bot, Room and their child sessions can read only THIS session.',
  inputSchema: { type: 'object', properties: { ref: { type: 'string' }, session_id: { type: 'string' }, seq: { type: 'integer' }, part: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' }, before: { type: 'integer' }, after: { type: 'integer' } } },
  approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
  async execute(ctx, args) {
   try { return !scoped(ctx.session) && read ? await read.execute(ctx, args) : readOwnSource(store, ctx.session.id, args as ReadArgs); }
   catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error) }; }
  }
 }];
}

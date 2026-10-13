import { resolveBotMemoryAgentId, type BotMemoryLookup, type BotMemorySession } from '../memory/bot-memory-scope.js';
import type { SessionRecord, SessionMessage } from '../types.js';

export interface HistoryStore extends BotMemoryLookup {
  listSessions(): SessionRecord[];
  getSession(id: string): SessionRecord | undefined;
  listSurfaceNodes(id: string): Array<Pick<SessionMessage, 'id' | 'parts' | 'role' | 'createdAt'> & { seq: number; surfaceOp: string }>;
}

const identity = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
/** Unknown ownership never grants access to another session, even in anonymous hosts. */
export function canReadHistory(source: BotMemorySession, target: BotMemorySession, store: BotMemoryLookup): boolean {
  if (source.id && source.id === target.id) return true;
  const owner = identity(source.metadata?.userId);
  return Boolean(owner && owner === identity(target.metadata?.userId)
    && identity(source.metadata?.tenantId) === identity(target.metadata?.tenantId)
    && resolveBotMemoryAgentId(source, store) === resolveBotMemoryAgentId(target, store));
}

export function sourcePage(text: string, offset?: number, limit?: number) {
  const start = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, text.length) : 0;
  const count = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 12000) : 4000;
  const end = Math.min(start + count, text.length);
  return { text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

export function historyReference(sessionId: string, messageId: string, part: number): string {
  return `history:${encodeURIComponent(sessionId)}:${encodeURIComponent(messageId)}:${part}`;
}
function partText(part: SessionMessage['parts'][number]): string | undefined {
  if (part.type === 'text') return part.text;
  if (part.type === 'tool_result') return part.content;
  return undefined;
}
export function searchHistory(store: HistoryStore, sourceId: string, args: { query: string; limit?: number; session_id?: string }) {
  const source = store.getSession(sourceId);
  const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
  const matches: Array<Record<string, unknown>> = [];
  if (!source || !query) return { matches };
  const limit = Number.isSafeInteger(args.limit) && args.limit! > 0 ? Math.min(args.limit!, 20) : 5;
  for (const session of store.listSessions()) {
    if (args.session_id && args.session_id !== session.id) continue;
    if (!canReadHistory(source, session, store)) continue;
    for (const message of store.listSurfaceNodes(session.id)) {
      if (message.surfaceOp !== 'append') continue;
      for (let part = 0; part < message.parts.length; part++) {
        const text = partText(message.parts[part]!);
        if (!text) continue;
        const at = text.toLocaleLowerCase().indexOf(query);
        if (at < 0) continue;
        matches.push({ ref: historyReference(session.id, message.id, part), sessionId: session.id,
          title: session.title, messageId: message.id, seq: message.seq, part,
          role: message.role, createdAt: message.createdAt,
          excerpt: text.slice(Math.max(0, at - 80), Math.max(0, at - 80) + 320) });
        if (matches.length === limit) return { matches };
      }
    }
  }
  return { matches };
}

export function readHistory(store: HistoryStore, sourceId: string, args: {
  ref?: string; session_id?: string; seq?: number; part?: number; offset?: number; limit?: number;
}) {
  let sessionId = args.session_id ?? sourceId;
  let messageId: string | undefined;
  let part = args.part ?? 0;
  if (args.ref) {
    const match = /^history:([^:]+):([^:]+):(\d+)$/.exec(args.ref);
    if (!match) return null;
    try { sessionId = decodeURIComponent(match[1]!); messageId = decodeURIComponent(match[2]!); part = Number(match[3]); }
    catch { return null; }
  } else if (!Number.isSafeInteger(args.seq) || args.seq! < 1) return null;
  if (!Number.isSafeInteger(part) || part < 0) return null;
  const source = store.getSession(sourceId), target = store.getSession(sessionId);
  if (!source || !target || !canReadHistory(source, target, store)) return null;
  const message = store.listSurfaceNodes(sessionId).find(m => m.surfaceOp === 'append' && (messageId ? m.id === messageId : m.seq === args.seq));
  if (!message || !message.parts[part]) return null;
  const text = partText(message.parts[part]!);
  if (text === undefined) return null;
  return { ref: historyReference(sessionId, message.id, part), sessionId, messageId: message.id,
    seq: message.seq, part, ...sourcePage(text, args.offset, args.limit) };
}

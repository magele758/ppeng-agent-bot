import type { ToolContract } from '../types.js';
import { searchHistory, readHistory, type HistoryStore } from '../session/history-retrieval.js';

export function createHistoryTools(services: { historyStore?: HistoryStore }): ToolContract<any>[] {
  if (!services.historyStore) return [];
  const store = services.historyStore;
  return [{
    name: 'history_search',
    description: 'Find original text and tool results, including compressed history, in sessions visible to your current identity. Search by exact keyword or phrase; returns excerpts and references for history_read. Does not search other users, tenants, or Bot namespaces.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, session_id: { type: 'string' } }, required: ['query'] },
    approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
    async execute(context, args) {
      if (typeof args.query !== 'string' || !args.query.trim()) return { ok: false, content: 'query is required' };
      return { ok: true, content: JSON.stringify(searchHistory(store, context.session.id, args)) };
    }
  }, {
    name: 'history_read',
    description: 'Read original historical evidence by history_search ref, or by session_id and seq from a compression source note. part defaults to 0. offset and limit are character counts; follow nextOffset until null. Access is rechecked on every page.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, session_id: { type: 'string' }, seq: { type: 'number' }, part: { type: 'number' }, offset: { type: 'number' }, limit: { type: 'number' } } },
    approvalMode: 'never', sideEffectLevel: 'none', ptc: { kind: 'read' },
    async execute(context, args) {
      const page = readHistory(store, context.session.id, args);
      return page ? { ok: true, content: JSON.stringify(page) } : { ok: false, content: 'Source unavailable.' };
    }
  }];
}

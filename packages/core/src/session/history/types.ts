import type { SessionMessage } from '../../types.js';
export interface HistoryOptions { limit?: number; beforeSeq?: number; query?: string; from?: string; to?: string; role?: string }
export interface HistoryPage { messages: SessionMessage[]; nextCursor: number | null; hasMore: boolean }
export interface HistoryContext { message: SessionMessage; messages: SessionMessage[] }
export interface HistoryStore {
 listHistory(sessionId: string, options?: HistoryOptions): HistoryPage;
 readHistory(sessionId: string, seq: number, before?: number, after?: number): HistoryContext | undefined;
 readHistoryById?(sessionId: string, messageId: string): SessionMessage | undefined;
}

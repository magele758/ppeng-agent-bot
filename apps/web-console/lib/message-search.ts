import { api } from './api.ts';
import type { MessageKey } from './i18n/messages/types.ts';

export const MESSAGE_SEARCH_LIMIT = 20;
export const MESSAGE_SEARCH_DEBOUNCE_MS = 300;

export type MessageSearchHit = {
  sessionId: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: string;
  sessionTitle: string;
  agentId: string;
};

export type MessageSearchPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export type MessageSearchView = {
  phase: MessageSearchPhase;
  hits: MessageSearchHit[];
  errorDetail: string;
};

export type MessageSearchFetcher = (path: string, init?: RequestInit) => Promise<unknown>;

type MessageSearchListener = (view: MessageSearchView) => void;

export function idleMessageSearch(): MessageSearchView {
  return { phase: 'idle', hits: [], errorDetail: '' };
}

export function loadingMessageSearch(): MessageSearchView {
  return { phase: 'loading', hits: [], errorDetail: '' };
}

/** Empty or whitespace `q` returns null so callers skip the request. */
export function messageSearchPath(q: string, limit = MESSAGE_SEARCH_LIMIT): string | null {
  const query = q.trim();
  if (!query) return null;
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return `/api/search/messages?${params.toString()}`;
}

export function messageSearchSettled(hits: MessageSearchHit[]): MessageSearchView {
  if (hits.length === 0) return { phase: 'empty', hits: [], errorDetail: '' };
  return { phase: 'ready', hits, errorDetail: '' };
}

export function messageSearchFailed(error: unknown): MessageSearchView {
  return { phase: 'error', hits: [], errorDetail: messageSearchErrorDetail(error) };
}

export function messageSearchAborted(error: unknown): boolean {
  if (!isErrorRecord(error)) return false;
  return error.name === 'AbortError';
}

export function formatMessageSearchTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function hitTitle(hit: MessageSearchHit, untitled: string): string {
  const title = hit.sessionTitle.trim();
  if (title) return title;
  return untitled;
}

export function hitKey(hit: MessageSearchHit): string {
  return `${hit.sessionId}:${hit.messageId}:${hit.createdAt}`;
}

type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function messageSearchStatusText(view: MessageSearchView, t: Translator): string | null {
  if (view.phase === 'loading') return t('play.messageSearch.loading');
  if (view.phase === 'empty') return t('play.messageSearch.empty');
  if (view.phase === 'error') return messageSearchErrorText(view.errorDetail, t);
  return null;
}

export function messageSearchErrorText(detail: string, t: Translator): string {
  if (detail.includes('404')) return t('play.messageSearch.unavailable');
  if (detail === 'invalid') return t('play.messageSearch.invalid');
  return t('play.messageSearch.failed', { detail });
}

export function parseMessageSearchHits(data: unknown): MessageSearchHit[] {
  const hits = hitsOf(data);
  if (!hits) throw new Error('invalid');
  return hits.flatMap(readHit);
}

export async function loadMessageSearch(
  path: string,
  fetcher: MessageSearchFetcher,
  signal?: AbortSignal
): Promise<MessageSearchHit[]> {
  const data = await fetcher(path, { signal });
  return parseMessageSearchHits(data);
}

export function subscribeMessageSearch(
  query: string,
  setView: MessageSearchListener,
  fetcher: MessageSearchFetcher = api,
  delay = MESSAGE_SEARCH_DEBOUNCE_MS
): () => void {
  const path = messageSearchPath(query);
  if (!path) {
    setView(idleMessageSearch());
    return () => undefined;
  }
  return scheduleMessageSearch(path, setView, fetcher, delay);
}

function scheduleMessageSearch(
  path: string,
  setView: MessageSearchListener,
  fetcher: MessageSearchFetcher,
  delay: number
): () => void {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    setView(loadingMessageSearch());
    void finishMessageSearch(path, ac.signal, setView, fetcher);
  }, delay);
  return () => {
    clearTimeout(timer);
    ac.abort();
  };
}

async function finishMessageSearch(
  path: string,
  signal: AbortSignal,
  setView: MessageSearchListener,
  fetcher: MessageSearchFetcher
): Promise<void> {
  try {
    const hits = await loadMessageSearch(path, fetcher, signal);
    publishHits(signal, hits, setView);
  } catch (error) {
    publishFailure(signal, error, setView);
  }
}

function publishHits(signal: AbortSignal, hits: MessageSearchHit[], setView: MessageSearchListener): void {
  if (signal.aborted) return;
  setView(messageSearchSettled(hits));
}

function publishFailure(signal: AbortSignal, error: unknown, setView: MessageSearchListener): void {
  if (signal.aborted || messageSearchAborted(error)) return;
  setView(messageSearchFailed(error));
}

function messageSearchErrorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isErrorRecord(error: unknown): error is { name?: string } {
  if (!error || typeof error !== 'object') return false;
  return true;
}

function hitsOf(data: unknown): unknown[] | null {
  const body = asRecord(data);
  if (!body) return null;
  if (!Array.isArray(body.hits)) return null;
  return body.hits;
}

function readHit(value: unknown): MessageSearchHit[] {
  const hit = hitFromRow(asRecord(value));
  if (!hit) return [];
  return [hit];
}

function hitFromRow(row: Record<string, unknown> | null): MessageSearchHit | null {
  if (!row) return null;
  const sessionId = stringField(row, 'sessionId');
  if (!sessionId) return null;
  return {
    sessionId,
    messageId: stringField(row, 'messageId'),
    role: stringField(row, 'role'),
    snippet: stringField(row, 'snippet'),
    createdAt: stringField(row, 'createdAt'),
    sessionTitle: stringField(row, 'sessionTitle'),
    agentId: stringField(row, 'agentId')
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') return '';
  return value;
}

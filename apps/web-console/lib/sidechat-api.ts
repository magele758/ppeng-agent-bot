import type { SidechatSearchHit, SidechatThread, SidechatMessage } from '@ppeng/api-types';
import { api } from './api';
import type { SidechatEditorTarget } from './sidechat-editor';

export type SidechatDetail = { thread: SidechatThread; messages: SidechatMessage[]; sourceAvailable?: boolean };
export type SidechatQuery = {
  sessionId?: string;
  q?: string;
  exactQuote?: string;
  excludeSessionId?: string;
  botId?: string;
  from?: string;
  to?: string;
};
export type SidechatPage = { items: SidechatSearchHit[]; nextCursor?: number | null };
const base = '/api/sidechats';
function threadPath(id: string) {
  return base + '/' + encodeURIComponent(id);
}

export function getSidechat(id: string, signal?: AbortSignal) {
  return api(threadPath(id), { signal }) as Promise<SidechatDetail>;
}
export function searchSidechats(query: SidechatQuery, cursor: number, signal?: AbortSignal) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  params.set('limit', '50');
  params.set('cursor', String(cursor));
  return api(base + '?' + params, { signal }) as Promise<SidechatPage>;
}
export async function sessionSidechats(sessionId: string, signal?: AbortSignal) {
  const threads = new Map<string, SidechatThread>();
  let cursor: number | null | undefined = 0;
  do {
    const page: SidechatPage = await searchSidechats({ sessionId }, cursor, signal);
    for (const hit of page.items) threads.set(hit.thread.id, hit.thread);
    cursor = nextPage(page, cursor);
  } while (cursor != null);
  return [...threads.values()];
}
function nextPage(page: SidechatPage, current: number) {
  const next = page.nextCursor;
  return next != null && next > current ? next : null;
}
function post(path: string, payload: object) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }) as Promise<SidechatDetail>;
}
export function submitSidechat(
  sessionId: string,
  target: SidechatEditorTarget,
  req: { requestId: string; question: string }
) {
  if (target.kind === 'thread') return post(threadPath(target.threadId) + '/messages', req);
  return post(base, { sessionId, messageId: target.messageId, anchor: target.anchor, ...req });
}
export function changeGeneration(threadId: string, action: 'stop' | 'retry', requestId: string, actionId: string) {
  return post(
    threadPath(threadId) + '/' + action,
    action === 'stop' ? { requestId, generationId: actionId } : { requestId, attemptId: actionId }
  );
}

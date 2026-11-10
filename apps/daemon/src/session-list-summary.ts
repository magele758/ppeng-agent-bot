import { createHash } from 'node:crypto';
import type { RouteContext } from './routing.js';
import { etagFromState, json, sendIfNotModified } from './http-utils.js';

const META_KEYS = ['botId', 'canonicalBotChat', 'roomId', 'parentSessionId', 'spawnSource', 'botGoalWorker', 'sourceMessageId', 'subagentRole', 'userId', 'tenantId', 'favorited'];
type ListSession = { id: string; title?: string; mode?: string; status?: string; agentId?: string; background?: boolean; createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown> };
export function sessionListSummary(session: ListSession) {
 const metadata = Object.fromEntries(META_KEYS.flatMap<[string, string | boolean]>(key => {
  const value = session.metadata?.[key];
  if (typeof value === 'string') return [[key, value.slice(0, 512)]];
  return typeof value === 'boolean' ? [[key, value]] : [];
 }));
 return { id: session.id, title: String(session.title ?? '').slice(0, 512), mode: session.mode,
  status: session.status, agentId: session.agentId, background: session.background,
  createdAt: session.createdAt, updatedAt: session.updatedAt, metadata };
}
export function sessionSummaryEtag(sessions: unknown[]): string {
 return 'W/"summary-' + createHash('sha256').update(JSON.stringify(sessions)).digest('hex') + '"';
}
export function sendSessionList(ctx: RouteContext, sessions: ListSession[], version: number): void {
 if (ctx.url.searchParams.get('view') !== 'summary') { sendFullList(ctx, sessions, version); return; }
 const summary = sessions.map(sessionListSummary);
 if (sendIfNotModified(ctx.request, ctx.response, sessionSummaryEtag(summary))) return;
 json(ctx.response, 200, { sessions: summary });
}

function sendFullList(ctx: RouteContext, sessions: ListSession[], version: number) {
 if (!ctx.url.searchParams.get('q')?.trim() && sendIfNotModified(ctx.request,ctx.response,etagFromState(version))) return;
 json(ctx.response,200,{sessions});
}

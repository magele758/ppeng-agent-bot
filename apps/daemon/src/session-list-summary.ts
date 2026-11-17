import { createHash } from 'node:crypto';
import type { RouteContext } from './routing.js';
import { etagFromState, json, sendIfNotModified } from './http-utils.js';

const META_KEYS = ['botId', 'canonicalBotChat', 'roomId', 'parentSessionId', 'spawnSource', 'botGoalWorker', 'sourceMessageId', 'subagentRole', 'userId', 'tenantId', 'favorited'];
type ListSession = { id: string; title?: string; mode?: string; status?: string; agentId?: string; background?: boolean; createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown> };
export function sessionListSummary(session: ListSession) {
 const metadata = {
  ...Object.fromEntries(META_KEYS.flatMap<[string, string | boolean]>(key => {
   const value = session.metadata?.[key];
   if (typeof value === 'string') return [[key, value.slice(0, 512)]];
   return typeof value === 'boolean' ? [[key, value]] : [];
  })),
  ...grantSummary(session.metadata?.sessionToolGrants)
 };
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

function grantSummary(raw: unknown): { sessionToolGrants?: { toolName: string; isolation: string }[] } {
  if (!Array.isArray(raw)) return {};
  const sessionToolGrants = raw.flatMap(grantItem).slice(0, 32);
  if (!sessionToolGrants.length) return {};
  return { sessionToolGrants };
}

function grantItem(item: unknown): { toolName: string; isolation: string }[] {
  const fields = grantFields(item);
  if (!fields) return [];
  if (!grantTextOk(fields.toolName, fields.isolation)) return [];
  return [{ toolName: fields.toolName, isolation: fields.isolation }];
}

function grantFields(item: unknown): { toolName: string; isolation: string } | null {
  if (!grantRecord(item)) return null;
  const rec = item as { toolName?: unknown; isolation?: unknown };
  if (typeof rec.toolName !== 'string') return null;
  if (typeof rec.isolation !== 'string') return null;
  return { toolName: rec.toolName.trim().slice(0, 128), isolation: rec.isolation.trim().slice(0, 32) };
}

function grantRecord(item: unknown): boolean {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
}

function grantTextOk(toolName: string, isolation: string): boolean {
  return toolName.length > 0 && isolation.length > 0 && !toolName.includes('*') && isolation !== '*';
}

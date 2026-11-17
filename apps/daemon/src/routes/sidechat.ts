import { botDefinitionRef } from '../access/owners.js';
import { checkOwnerRef } from '../access/enforce.js';
import { guardSession, listedSessions } from '../session-guard.js';
import {
  canonicalBotIdFromSession,
  ConflictError,
  NotFoundError,
  ValidationError,
  type RawAgentRuntime,
  type RequestAuth,
  type SessionRecord
} from '@ppeng/agent-core';
import type { SidechatAnchor, SidechatDetail } from '@ppeng/api-types';
import { json } from '../http-utils.js';
import type { RouteContext, RouteSpec } from '../routing.js';
import { readSidechatSource, SidechatGeneration, sidechatSourceSeq } from '../sidechat-generation.js';
import { graspQuery, learningPatch } from '../sidechat-learning.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected an object');
  return value as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('Missing ' + key);
  return value;
}
function neighboringText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) throw new ValidationError('Invalid text adjacent to the quote');
  return value;
}
function anchorFrom(body: Record<string, unknown>, sourceText: string): SidechatAnchor {
  const a = record(body.anchor);
  const quote = text(a, 'quote');
  if (a.kind === 'message') return { kind: 'message', quote: sourceText };
  const start = Number.isSafeInteger(a.start) ? (a.start as number) : -1;
  const end = Number.isSafeInteger(a.end) ? (a.end as number) : -1;
  if (a.kind !== 'range' || start < 0 || end - start !== quote.length) throw new ValidationError('Invalid text range');
  return {
    kind: 'range',
    quote,
    start,
    end,
    prefix: neighboringText(a.prefix),
    suffix: neighboringText(a.suffix)
  };
}
function owner(auth: RequestAuth): string {
  return auth.user ? JSON.stringify([auth.user.tenantId, auth.user.id]) : 'local';
}
function detail(runtime: RawAgentRuntime, ctx: RouteContext): SidechatDetail {
  const id = ctx.requireParam('id'),
    principal = owner(ctx.auth);
  const sourceId = runtime.store.sidechats.sourceSessionId(principal, id);
  if (!sourceId) throw new NotFoundError('Sidechat');
  guardSession(runtime, sourceId, ctx.auth);
  const result = runtime.store.sidechats.get(principal, [sourceId], id);
  if (!result) throw new NotFoundError('Sidechat');
  return result;
}
function respond(ctx: RouteContext, detail: SidechatDetail, sourceAvailable: boolean) {
  const { messages, ...thread } = detail;
  json(ctx.response, 200, { thread, messages, sourceAvailable });
}

function removeSidechat(runtime: RawAgentRuntime, generation: SidechatGeneration, ctx: RouteContext) {
  const current = detail(runtime, ctx);
  if (!runtime.store.sidechats.remove(owner(ctx.auth), current.id)) throw new NotFoundError('Sidechat');
  generation.discard(current);
  json(ctx.response, 200, { deleted: true });
}

function currentDetail(runtime: RawAgentRuntime, ctx: RouteContext) {
  const current = detail(runtime, ctx);
  respond(ctx, current, sidechatSourceSeq(runtime, current.sessionId, current.messageId) !== undefined);
}

function limitOf(value: string | null): number {
  if (value === null) return 50;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new ValidationError('Invalid limit');
  return Math.min(n, 100);
}
function list(runtime: RawAgentRuntime, ctx: RouteContext) {
  const q = ctx.url.searchParams;
  const sessionId = q.get('sessionId') || undefined;
  const visible = sessionId
    ? [guardSession(runtime, sessionId, ctx.auth)!.id]
    : listedSessions(runtime, ctx.auth).map((s) => s.id);
  const limit = limitOf(q.get('limit')),
    offset = Number(q.get('cursor') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('Invalid cursor');
  const rows = runtime.store.sidechats.search(owner(ctx.auth), visible, {
    query: q.get('q') || undefined,
    exactQuote: q.get('exactQuote') || undefined,
    excludeSessionId: q.get('excludeSessionId') || undefined,
    sessionId,
    botId: q.get('botId') || undefined,
    from: q.get('from') || undefined,
    to: q.get('to') || undefined,
    grasp: graspQuery(q.get('grasp')),
    noted: q.get('noted') === '1',
    offset,
    limit: limit + 1
  });
  json(ctx.response, 200, {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? offset + limit : undefined
  });
}
function latestQuestion(thread: SidechatDetail, requestId: string): string {
  const msg = thread.messages.findLast((m) => m.role === 'user' && m.requestId === requestId);
  if (!msg) throw new NotFoundError('Sidechat question');
  return msg.text;
}
function patchLearning(runtime: RawAgentRuntime, ctx: RouteContext, body: Record<string, unknown>) {
  const current = detail(runtime, ctx);
  const patch = learningPatch(body);
  if (!runtime.store.sidechats.revise(owner(ctx.auth), current.id, patch)) throw new NotFoundError('Sidechat');
  currentDetail(runtime, ctx);
}

async function distillNote(runtime: RawAgentRuntime, generation: SidechatGeneration, ctx: RouteContext) {
  const current = detail(runtime, ctx);
  const session = guardSession(runtime, current.sessionId, ctx.auth)!;
  const revision = runtime.store.sidechats.beginNote(owner(ctx.auth), current.id);
  const note = await generation.distill(current, session, readSidechatSource(runtime, session.id, current.messageId));
  detail(runtime, ctx);
  if (!runtime.store.sidechats.finishNote(owner(ctx.auth), current.id, revision, note)) {
    throw new ConflictError('Sidechat note changed during generation');
  }
  currentDetail(runtime, ctx);
}

function sourceBotId(runtime: RawAgentRuntime, source: SessionRecord) {
  return runtime.findBotBySessionId(source.id)?.id ?? canonicalBotIdFromSession(source);
}
function guardAgentIdentity(runtime: RawAgentRuntime, auth: RequestAuth, agentId: string, botId?: string) {
  if (!auth.isolate) return;
  const identities = new Set([agentId, botId]);
  for (const id of identities) {
    if (!id || !runtime.store.getBot(id)) continue;
    checkOwnerRef(botDefinitionRef(runtime, id), { resource: 'bot' }, auth);
  }
}
type Action = 'create' | 'send' | 'retry';
function submit(
  runtime: RawAgentRuntime,
  generation: SidechatGeneration,
  ctx: RouteContext,
  body: Record<string, unknown>,
  action: Action
) {
  const prior = action === 'create' ? undefined : detail(runtime, ctx);
  const session = guardSession(runtime, prior?.sessionId ?? text(body, 'sessionId'), ctx.auth)!;
  if (session.metadata.roomId) throw new ValidationError('Sidechat requires a direct conversation');
  const botId = prior?.botId ?? sourceBotId(runtime, session);
  guardAgentIdentity(runtime, ctx.auth, prior?.agentId ?? session.agentId, botId);
  const messageId = prior?.messageId ?? text(body, 'messageId');
  const source = readSidechatSource(runtime, session.id, messageId);
  if (!prior && !source) throw new NotFoundError('Assistant reply');
  const requestId = text(body, 'requestId');
  const question = action === 'retry' ? latestQuestion(prior!, requestId) : text(body, 'question');
  const input = {
    sessionId: session.id,
    messageId,
    agentId: prior?.agentId ?? session.agentId,
    botId,
    question,
    requestId,
    anchor: prior?.anchor ?? anchorFrom(body, source!.answer),
    threadId: prior?.id,
    retry: action === 'retry',
    attemptId: action === 'retry' ? text(body, 'attemptId') : undefined
  };
  const claimed = runtime.store.sidechats.start(owner(ctx.auth), input);
  if (claimed.runId) generation.start(claimed.thread, claimed.runId, session, source);
  respond(ctx, claimed.thread, Boolean(source));
}

export function sidechatRoutes(runtime: RawAgentRuntime, env: NodeJS.ProcessEnv = process.env): RouteSpec[] {
  const generation = new SidechatGeneration(runtime, env);
  runtime.store.sidechats.recoverInterrupted();
  function submission(pattern: string, action: Action): RouteSpec {
    return {
      method: 'POST',
      pattern,
      handler: async (ctx) => submit(runtime, generation, ctx, record(await ctx.readBody()), action)
    };
  }
  return [
    { method: 'GET', pattern: '/api/sidechats', handler: (ctx) => list(runtime, ctx) },
    { method: 'GET', pattern: '/api/sidechats/:id', handler: (ctx) => currentDetail(runtime, ctx) },
    {
      method: 'DELETE',
      pattern: '/api/sidechats/:id',
      handler: (ctx) => removeSidechat(runtime, generation, ctx)
    },
    {
      method: 'PATCH',
      pattern: '/api/sidechats/:id',
      handler: async (ctx) => patchLearning(runtime, ctx, record(await ctx.readBody()))
    },
    {
      method: 'POST',
      pattern: '/api/sidechats/:id/note',
      handler: (ctx) => distillNote(runtime, generation, ctx)
    },
    submission('/api/sidechats', 'create'),
    submission('/api/sidechats/:id/messages', 'send'),
    submission('/api/sidechats/:id/retry', 'retry'),
    {
      method: 'POST',
      pattern: '/api/sidechats/:id/stop',
      handler: async (ctx) => {
        const body = record(await ctx.readBody());
        generation.stop(detail(runtime, ctx), text(body, 'requestId'), text(body, 'generationId'));
        currentDetail(runtime, ctx);
      }
    }
  ];
}

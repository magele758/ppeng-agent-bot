import { ConflictError, NotFoundError, ValidationError, type RawAgentRuntime, type DaydreamRun, type DaydreamSettings } from '@ppeng/agent-core';
import type { RouteSpec, RouteContext } from '../routing.js';
import { json } from '../http-utils.js';
import { guardSession } from '../session-guard.js';

function runView(run: DaydreamRun) {
  return { ...run, inputs: undefined, logicalDate: run.date, summary: run.error ?? '', outputs: run.outputs.map(output => ({
    kind: output.candidate.kind, conflict: output.candidate.conflict, status: output.status, summary: output.candidate.content,
    artifactId: output.artifactId, evidenceRefs: output.candidate.evidenceRefs?.map(e => ({ sessionId: e.sessionId, messageId: e.messageId })), error: output.error
  })) };
}
function validateDate(date: unknown): string | undefined {
  if (date === undefined) return undefined;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Invalid review date');
  if (!isCalendarDate(date)) throw new ValidationError('Invalid review date');
  return date;
}
function isCalendarDate(date: string): boolean {
  const parsed = Date.parse(date + 'T12:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('JSON object required');
  return value as Record<string, unknown>;
}
function evidenceOptions(runtime: RawAgentRuntime, id: string) {
  const sessionId = runtime.getBot(id).canonicalSessionId;
  return runtime.store.listMessages(sessionId).filter(m => !m.hidden && (m.role === 'user' || m.role === 'tool')).slice(-100).map(m => ({ sessionId, messageId: m.id, observedAt: m.createdAt }));
}
function feedbackEvidence(runtime: RawAgentRuntime, id: string, ids: unknown) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some(value => typeof value !== 'string')) throw new ValidationError('Select actual evidence messages');
  const allowed = new Map(evidenceOptions(runtime, id).map(e => [e.messageId, e]));
  return [...new Set(ids as string[])].map(messageId => {
    const evidence = allowed.get(messageId);
    if (!evidence) throw new ValidationError('Evidence message unavailable');
    return evidence;
  });
}
function validateRevision(body: Record<string, unknown>) {
  if (body.action !== 'revise') return;
  if (!Number.isInteger(body.expectedVersion) || typeof body.content !== 'string' || typeof body.summary !== 'string') throw new ValidationError('Revision content, summary and expected version required');
}
function feedbackView(runtime: RawAgentRuntime, id: string) {
  const actor = runtime.daydream.actor(id);
  if (runtime.daydream.knowledge.getPolicy(actor)?.superBotId !== id) return [];
  return runtime.daydream.knowledge.listFeedback(actor).map(feedback => {
    try { const artifact = runtime.daydream.knowledge.getArtifact(actor, feedback.artifactId, feedback.artifactVersion); return {...feedback, originalContent: artifact.content, originalSummary: artifact.summary, available: true}; }
    catch { return {...feedback, originalContent: '', originalSummary: '', available: false}; }
  });
}
function settingsView(runtime: RawAgentRuntime, id: string) {
  const policy = runtime.daydream.knowledge.getPolicy(runtime.daydream.actor(id));
  const actor = runtime.daydream.actor(id);
  const eligibleBotIds = runtime.listBots().filter(bot => { const candidate = runtime.daydream.actor(bot.id); return candidate.tenantId === actor.tenantId && candidate.scopeId === actor.scopeId; }).map(bot => bot.id);
  return { eligibleBotIds, settings: runtime.daydream.local.getSettings(id), policy: {
    superBotId: policy?.superBotId ?? '', publishPolicy: policy?.publishPolicy ?? 'review', sharedBotIds: policy?.allowedRecipientBotIds ?? []
  } };
}
function saveSettings(runtime: RawAgentRuntime, id: string, body: Record<string, unknown>) {
  const db = runtime.store.db;
  db.exec('SAVEPOINT daydream_settings');
  try {
    if (body.settings !== undefined) runtime.daydream.local.patchSettings(id, objectBody(body.settings) as Partial<DaydreamSettings>);
    if (body.policy !== undefined) savePolicy(runtime, id, objectBody(body.policy));
    db.exec('RELEASE daydream_settings');
  } catch (error) {
    db.exec('ROLLBACK TO daydream_settings'); db.exec('RELEASE daydream_settings'); throw error;
  }
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function savePolicy(runtime: RawAgentRuntime, id: string, policy: Record<string, unknown>) {
  if (typeof policy.superBotId !== 'string' || !stringArray(policy.sharedBotIds)) throw new ValidationError('Invalid sharing scope');
  if (!['review', 'autoWithinScope'].includes(String(policy.publishPolicy))) throw new ValidationError('Invalid sharing policy');
  const actor = runtime.daydream.actor(id, true);
  if (!policy.superBotId) { runtime.daydream.knowledge.clearPolicy(actor); return; }
  runtime.daydream.knowledge.savePolicy(actor, { superBotId: policy.superBotId, publishPolicy: policy.publishPolicy as 'review' | 'autoWithinScope', allowedRecipientBotIds: policy.sharedBotIds as string[] });
}
export function botDaydreamRoutes(runtime: RawAgentRuntime): RouteSpec[] {
  const bot = (ctx: RouteContext) => { const id = ctx.requireParam('id'); guardSession(runtime, runtime.getBot(id).canonicalSessionId, ctx.auth); return id; };
  const routes: RouteSpec[] = [
    { method: 'GET', pattern: '/api/bots/:id/daydream/settings', handler: ctx => json(ctx.response, 200, settingsView(runtime, bot(ctx))) },
    { method: 'PATCH', pattern: '/api/bots/:id/daydream/settings', handler: async ctx => { const id = bot(ctx); saveSettings(runtime, id, objectBody(await ctx.readBody())); json(ctx.response, 200, settingsView(runtime, id)); } },
    { method: 'GET', pattern: '/api/bots/:id/daydream/runs', handler: ctx => json(ctx.response, 200, { runs: runtime.daydream.local.listRuns(bot(ctx)).map(runView) }) },
    { method: 'GET', pattern: '/api/bots/:id/daydream/runs/:runId', handler: ctx => {
      const run = runtime.daydream.local.getRun(bot(ctx), ctx.requireParam('runId'));
      if (!run) throw new NotFoundError('Daydream run');
      json(ctx.response, 200, { run: runView(run) });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/runs', handler: async ctx => {
      const id = bot(ctx); const body = objectBody(await ctx.readBody()); const date = validateDate(body.date);
      if (!runtime.daydream.local.getSettings(id).enabled) throw new ValidationError('Daydream disabled');
      if (runtime.daydream.local.isBusy(id)) throw new ConflictError('A review is already running for this Bot');
      void runtime.daydream.local.run(id, { date, manual: true }).catch(() => {});
      json(ctx.response, 202, { runs: runtime.daydream.local.listRuns(id).map(runView) });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/runs/:runId/outputs/:index/review', handler: async ctx => {
      const id = bot(ctx); const body = objectBody(await ctx.readBody()); const index = Number(ctx.requireParam('index'));
      if (typeof body.accept !== 'boolean' || !Number.isInteger(index) || index < 0) throw new ValidationError('Valid index and accept boolean required');
      const run = await runtime.daydream.local.reviewOutput(id, ctx.requireParam('runId'), index, body.accept); json(ctx.response, 200, { run: runView(run) });
    } },
    { method: 'GET', pattern: '/api/bots/:id/daydream/knowledge', handler: ctx => {
      const id = bot(ctx); const a = runtime.daydream.actor(id); const k = runtime.daydream.knowledge; const policy = k.getPolicy(a);
      json(ctx.response, 200, { submissions: k.listSubmissions(a), artifacts: k.listArtifacts(a).map(x => ({ ...x, currentVersion: x.version })), canGovern: policy?.superBotId === id, feedback: feedbackView(runtime, id), evidenceOptions: evidenceOptions(runtime, id) });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/knowledge/govern', handler: async ctx => { const id = bot(ctx); json(ctx.response, 200, { submissions: await runtime.daydream.govern(id) }); } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/knowledge/:submissionId/decision', handler: async ctx => {
      const id = bot(ctx); const body = objectBody(await ctx.readBody()); const actions = { accept: 'publish', reject: 'reject', defer: 'needsEvidence' } as const;
      const action = actions[String(body.decision) as keyof typeof actions]; if (!action) throw new ValidationError('Invalid decision');
      const a = runtime.daydream.actor(id, true); const k = runtime.daydream.knowledge; const batch = k.startBatch(a);
      const submission = k.listSubmissions(a).find(s => s.id === ctx.requireParam('submissionId'));
      const expectedVersion = submission?.targetSharedId ? k.getArtifact(a, submission.targetSharedId).version : undefined;
      json(ctx.response, 200, { submission: k.decide(a, batch.id, ctx.requireParam('submissionId'), { action, reason: 'User decision', expectedVersion }) });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/knowledge/:artifactId/revoke', handler: async ctx => {
      const a = runtime.daydream.actor(bot(ctx), true); const body = objectBody(await ctx.readBody());
      if (!Number.isInteger(body.version)) throw new ValidationError('Version required');
      runtime.daydream.knowledge.revoke(a, ctx.requireParam('artifactId'), body.version as number); json(ctx.response, 200, { ok: true });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/knowledge/feedback/:feedbackId/decision', handler: async ctx => {
      const actor = runtime.daydream.actor(bot(ctx), true); const body = objectBody(await ctx.readBody());
      if (!['revise', 'dismiss'].includes(String(body.action)) || typeof body.reason !== 'string') throw new ValidationError('Feedback action and reason required');
      validateRevision(body);
      const knowledge = runtime.daydream.knowledge; const batch = knowledge.startBatch(actor);
      const feedback = knowledge.decideFeedback(actor, batch.id, ctx.requireParam('feedbackId'), { action: body.action as 'revise' | 'dismiss', reason: body.reason, expectedVersion: body.expectedVersion as number | undefined, content: body.content as string | undefined, summary: body.summary as string | undefined });
      json(ctx.response, 200, { feedback });
    } },
    { method: 'POST', pattern: '/api/bots/:id/daydream/knowledge/:artifactId/feedback', handler: async ctx => {
      const id = bot(ctx); const body = objectBody(await ctx.readBody());
      if (!Number.isInteger(body.version) || typeof body.description !== 'string') throw new ValidationError('Version and description required');
      const kind = String(body.kind); if (!['verified', 'failed', 'correction', 'extension'].includes(kind)) throw new ValidationError('Invalid feedback kind');
      const feedback = runtime.daydream.knowledge.feedback(runtime.daydream.actor(id), { artifactId: ctx.requireParam('artifactId'), artifactVersion: body.version as number, kind: kind as 'verified' | 'failed' | 'correction' | 'extension', description: body.description, evidenceRefs: feedbackEvidence(runtime, id, body.messageIds) });
      json(ctx.response, 200, { feedback });
    } }
  ];
  return routes.map(route => ({ ...route, handler: async ctx => { try { return await route.handler(ctx); } catch (error) { if (error instanceof Error && ['Error', 'RangeError'].includes(error.name)) throw new ValidationError(error.message); throw error; } } }));
}

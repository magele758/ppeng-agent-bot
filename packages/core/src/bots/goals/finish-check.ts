import type { SqliteStateStore } from '../../storage.js';
import type { ModelAdapter, SessionMessage, SessionRecord } from '../../types.js';
import { GOAL_JUDGE_TIMEOUT_MS } from './judge-budget.js';
import { BotGoalService } from './service.js';
import { readBotFinishSettings, type BotFinishSettings } from './finish-settings.js';
import { hasDurableWake, readFinishWake, registerFinishWake, type FinishWakeDecision } from './finish-wake.js';
import type { GoalTraceKind } from './runtime-host.js';

export interface FinishCheckHost {
  store: SqliteStateStore;
  judgeForSession?(session: SessionRecord): ModelAdapter['completeText'];
  judge?: ModelAdapter['completeText'];
  emitTrace?(sessionId: string, event: { kind: GoalTraceKind; payload: Record<string, unknown> }): void;
}

export type FinishVerdict = 'continue' | 'wake' | 'stop';
export interface FinishJudgement { verdict: FinishVerdict; category: string; reason: string; nextStep?: string }
export type FinishGateResult = { met: boolean; action?: 'continue'; reason?: string; systemMessage?: string };

interface RunState { startSeq: number; continuations: number; toolCallsAtPushback: number }
const runs = new WeakMap<object, Map<string, RunState>>();

function runMap(store: object): Map<string, RunState> {
  let map = runs.get(store);
  if (!map) { map = new Map(); runs.set(store, map); }
  return map;
}

/** Call when a run starts. Only messages after this point count as "this run". */
export function noteFinishRunStart(store: Pick<SqliteStateStore, 'listSurfaceNodes'>, sessionId: string): void {
  const map = runMap(store);
  if (map.size >= 2048 && !map.has(sessionId)) return;
  map.set(sessionId, { startSeq: store.listSurfaceNodes(sessionId).at(-1)?.seq ?? 0, continuations: 0, toolCallsAtPushback: 0 });
}

export function clearFinishRun(store: object, sessionId: string): void {
  runs.get(store)?.delete(sessionId);
}

const PROMISE_CUE = /接下来我?(?:会|将|来|要|就)|下一步我?(?:会|将|来|要)|我(?:这就|马上|现在就|先去|继续|接着|随后|然后)(?:去|来|会)?|稍等|马上(?:开始|处理|去做)|\b(?:let me|i(?:'ll| will) (?:now|next|then|continue|proceed|start|go ahead)|next,? i(?:'ll| will)|i(?:'m| am) going to)\b/i;
const ASK_CUE = /要不要我?|需要我(?:继续|帮|来|再)|是否(?:需要|继续|要我?)|要我(?:继续|接着|帮)|(?:继续|开始|执行|处理|修复|实现)(?:吗|么)[？?]?|你(?:想|希望|要)我|请(?:你)?确认|确认后|等你(?:确认|回复|指示)|告诉我(?:是否|要不要|下一步)|\b(?:shall i|should i|do you want me to|would you like me to|want me to|let me know (?:if|whether|which|how)|please confirm|if you(?:'d| would) like)\b/i;
const DEFER_CUE = /稍后|晚点|晚些|过一会|完成后|跑完后|结束后|有结果(?:了)?(?:再|后|就|会)|有进展(?:再|后|就|会)|到时候|等[^。\n]{0,24}(?:完成|结束|出来|跑完)[^。\n]{0,8}(?:再|后|会|就)|(?:后台|远端|远程)[^。\n]{0,12}(?:运行|跑|执行|训练|构建|下载)|正在(?:后台)?(?:运行|跑|执行|训练|构建|下载|部署)|\b(?:will (?:report|update you|let you know|check back)|i(?:'ll| will) (?:report|get back|check back|follow up|update you)|once (?:it|that|the)[^.\n]{0,40}(?:finish|complete|done)|when it(?:'s| is) (?:done|finished|ready)|running in the background|still running)\b/i;
const NEEDS_USER_CUE = /登录|登陆|扫码|验证码|凭证|密码|密钥|token|授权|权限|付款|支付|不可逆|无法撤销|credential|password|log ?in|sign ?in|api key|approve|permission|irreversible/i;

export interface FinishSignals { promise: boolean; ask: boolean; defer: boolean; needsUser: boolean; openTodos: string[]; toolCalls: number; toolNames: string[] }

function textOf(message: SessionMessage | undefined): string {
  return message?.parts.filter(part => part.type === 'text').map(part => (part as { text?: string }).text ?? '').join('\n') ?? '';
}

function toolCallsOf(messages: SessionMessage[]): Array<{ name: string; input: unknown }> {
  return messages.flatMap(message => message.parts
    .filter(part => part.type === 'tool_call')
    .map(part => ({ name: String((part as { name?: unknown }).name ?? ''), input: (part as { input?: unknown }).input })));
}

/** Open items of the last todo list written in this run. Lists left by earlier runs are not read. */
export function openTodosWrittenInRun(calls: Array<{ name: string; input: unknown }>): string[] {
  const last = calls.findLast(call => call.name === 'TodoWrite');
  const items = (last?.input as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is { content?: unknown; status?: unknown } => !!item && typeof item === 'object')
    .filter(item => item.status !== 'completed')
    .map(item => String(item.content ?? '').slice(0, 200))
    .filter(Boolean);
}

export function finishSignals(reply: string, calls: Array<{ name: string; input: unknown }>): FinishSignals {
  return {
    promise: PROMISE_CUE.test(reply),
    ask: ASK_CUE.test(reply),
    defer: DEFER_CUE.test(reply),
    needsUser: NEEDS_USER_CUE.test(reply),
    openTodos: openTodosWrittenInRun(calls),
    toolCalls: calls.length,
    toolNames: calls.slice(-12).map(call => call.name),
  };
}

function worthJudging(signals: FinishSignals): boolean {
  return signals.promise || signals.ask || signals.defer || signals.openTodos.length > 0;
}

// Must not start with "Evaluate": scripted judges in tests key the completion judge on that word.
export const FINISH_JUDGE_PROMPT = [
  'You review the last reply of an assistant that is about to stop working on a user request. Decide what should happen next.',
  'verdict "continue": the reply promises more work it has not done, or stops to ask the user about a next step the assistant can safely decide and do itself, or leaves its own open steps unfinished although nothing blocks them.',
  'verdict "wake": the reply says it will report later or when something finishes, and that work is still running elsewhere (background or remote job), so there is nothing to do right now.',
  'verdict "stop": the request is answered (an optional offer of further help is fine); or the next step truly needs the user: login, credentials, payment, approval of an irreversible, destructive or externally visible action, a choice only they can make, or missing information; or the user asked to discuss or confirm first; or it is small talk.',
  'When unsure, answer "stop".',
  'Return JSON {"verdict":"continue"|"wake"|"stop","category":"promised_not_done"|"asked_decidable"|"open_todo"|"deferred_report"|"needs_user"|"optional_offer"|"done","reason":"one short sentence","nextStep":"what to do now, when verdict is continue"}.',
].join('\n');

const VERDICTS = new Set<FinishVerdict>(['continue', 'wake', 'stop']);

export function parseFinishJudgement(output: unknown): FinishJudgement {
  const decoded = (typeof output === 'string' ? JSON.parse(output) : output) as Record<string, unknown> | null;
  const verdict = decoded?.verdict as FinishVerdict;
  if (!VERDICTS.has(verdict)) throw new Error('Invalid finish verdict');
  return {
    verdict,
    category: typeof decoded!.category === 'string' ? decoded!.category.slice(0, 40) : 'unknown',
    reason: typeof decoded!.reason === 'string' ? decoded!.reason.slice(0, 400) : '',
    ...(typeof decoded!.nextStep === 'string' && decoded!.nextStep.trim() ? { nextStep: decoded!.nextStep.slice(0, 600) } : {}),
  };
}

interface JudgeOutcome { judgement?: FinishJudgement; error?: string; timedOut?: boolean; attempts: number }

async function askJudge(judge: NonNullable<ModelAdapter['completeText']>, packet: unknown, signal?: AbortSignal): Promise<JudgeOutcome> {
  let error = '';
  let timedOut = false;
  // One retry: a transient failure should not decide whether work continues.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timeout = AbortSignal.timeout(GOAL_JUDGE_TIMEOUT_MS);
    try {
      const output = await judge({ system: FINISH_JUDGE_PROMPT, user: JSON.stringify(packet), jsonMode: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return { judgement: parseFinishJudgement(output), attempts: attempt };
    } catch (cause) {
      error = String(cause);
      timedOut = timeout.aborted;
      if (signal?.aborted) break;
    }
  }
  return { error: error.slice(0, 400), timedOut, attempts: 2 };
}

/** The judge failed. Only this run's own unfinished todo list is strong enough to continue without it. */
function fallbackJudgement(signals: FinishSignals): FinishJudgement {
  if (signals.openTodos.length > 0 && !signals.needsUser && !signals.ask && !signals.defer) {
    return { verdict: 'continue', category: 'open_todo', reason: 'Steps listed in this run are still open', nextStep: signals.openTodos[0] };
  }
  return { verdict: 'stop', category: 'judge_unavailable', reason: 'Finish judge unavailable; reply let through' };
}

function lastHumanMessage(messages: SessionMessage[]): SessionMessage | undefined {
  return messages.findLast(message => message.role === 'user' && !message.key);
}

function hasPendingApproval(store: SqliteStateStore, sessionId: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND status='pending' LIMIT 1").get(sessionId));
}

/** Ends the runtime must never reopen. */
function untouchable(store: SqliteStateStore, session: SessionRecord, signal: AbortSignal | undefined, finalTurn: boolean): boolean {
  if (finalTurn || signal?.aborted) return true;
  if (session.status === 'waiting_approval' || hasPendingApproval(store, session.id)) return true;
  const meta = session.metadata ?? {};
  return Boolean(meta.botGoalBudgetExceeded || meta.botWorkTaskId || meta.botGoalWorker) || ownedByGoal(store, session);
}

/** A turn bound to a live goal execution is checked by the goal's own completion judge. */
function ownedByGoal(store: SqliteStateStore, session: SessionRecord): boolean {
  const { botId, botGoalId, botGoalExecutionId } = session.metadata ?? {};
  if (typeof botId !== 'string' || typeof botGoalId !== 'string' || typeof botGoalExecutionId !== 'string') return false;
  return new BotGoalService(store, Date.now, session.id).get(botId, botGoalId)?.activeExecutionId === botGoalExecutionId;
}

function continueMessage(judgement: FinishJudgement, signals: FinishSignals): string {
  const todo = signals.openTodos.length ? ` Open steps from your own list: ${signals.openTodos.slice(0, 5).join('; ')}.` : '';
  const next = judgement.nextStep ? ` Next: ${judgement.nextStep}` : '';
  return `[finish check] The work is not finished: ${judgement.reason || 'the reply stopped before the remaining steps were done'}.${next}${todo}\nKeep working now and do the remaining steps yourself with the tools you have. Decide ordinary next steps on your own instead of asking. Stop only when the request is done, or when something truly needs the user (login, credentials, confirming an irreversible action); in that case say exactly what you need.`;
}

interface CheckContext { host: FinishCheckHost; session: SessionRecord; settings: BotFinishSettings; state: RunState; signals: FinishSignals; reply: string; human: SessionMessage | undefined }

function trace(ctx: CheckContext, payload: Record<string, unknown>): void {
  ctx.host.emitTrace?.(ctx.session.id, { kind: 'finish_check', payload: {
    continuations: ctx.state.continuations, maxContinuations: ctx.settings.maxContinuations,
    openTodos: ctx.signals.openTodos.length, toolCalls: ctx.signals.toolCalls, failOpen: false, ...payload,
  } });
}

/** A run already sent back that made no tool call since, or that used up its allowance, ends here. */
function exhausted(ctx: CheckContext): string | undefined {
  if (ctx.state.continuations >= ctx.settings.maxContinuations) return 'continuation_cap';
  if (ctx.state.continuations > 0 && ctx.signals.toolCalls <= ctx.state.toolCallsAtPushback) return 'no_progress';
  return undefined;
}

function applyWake(ctx: CheckContext, judgement: FinishJudgement, base: Record<string, unknown>): FinishGateResult {
  if (!ctx.settings.wakeEnabled) {
    trace(ctx, { ...base, decision: 'allow', wake: 'disabled' });
    return { met: true };
  }
  if (hasDurableWake(ctx.host.store, ctx.session, ctx.signals.toolNames)) {
    trace(ctx, { ...base, decision: 'allow', deferredWithoutWake: false, wake: 'already_registered' });
    return { met: true };
  }
  const wake: FinishWakeDecision = registerFinishWake(ctx.host.store, ctx.session.id, {
    settings: ctx.settings, humanMessageId: ctx.human?.id, promise: ctx.reply.slice(-600), reason: judgement.reason,
  });
  trace(ctx, { ...base, decision: 'allow', deferredWithoutWake: true, wake: wake.registered ? 'registered' : wake.reason, wakeCount: wake.count, ...(wake.dueAt ? { wakeDueAt: new Date(wake.dueAt).toISOString() } : {}) });
  return { met: true };
}

function applyJudgement(ctx: CheckContext, judgement: FinishJudgement, base: Record<string, unknown>): FinishGateResult {
  if (judgement.verdict === 'wake') return applyWake(ctx, judgement, base);
  if (judgement.verdict === 'stop' || !ctx.settings.finishCheckEnabled) {
    trace(ctx, { ...base, decision: 'allow' });
    return { met: true };
  }
  const spent = exhausted(ctx);
  if (spent) {
    trace(ctx, { ...base, decision: 'allow', stopped: spent });
    return { met: true };
  }
  ctx.state.continuations += 1;
  ctx.state.toolCallsAtPushback = ctx.signals.toolCalls;
  trace(ctx, { ...base, decision: 'continue', continuations: ctx.state.continuations });
  return { met: false, action: 'continue', reason: judgement.reason, systemMessage: continueMessage(judgement, ctx.signals) };
}

async function judged(ctx: CheckContext, signal?: AbortSignal): Promise<FinishGateResult> {
  const judge = ctx.host.judgeForSession ? ctx.host.judgeForSession(ctx.session) : ctx.host.judge;
  const packet = {
    userRequest: textOf(ctx.human).slice(0, 2000), assistantReply: ctx.reply.slice(-4000),
    toolCallsThisRun: ctx.signals.toolCalls, recentTools: ctx.signals.toolNames, openTodos: ctx.signals.openTodos.slice(0, 10),
    runningBackgroundJobs: ctx.host.store.listBackgroundJobs(ctx.session.id).filter(job => job.status === 'running').length,
  };
  const outcome: JudgeOutcome = judge ? await askJudge(judge, packet, signal) : { error: 'No finish judge is available', attempts: 0 };
  if (signal?.aborted) return { met: true };
  if (outcome.judgement) {
    return applyJudgement(ctx, outcome.judgement, { source: 'judge', verdict: outcome.judgement.verdict, category: outcome.judgement.category, reason: outcome.judgement.reason, judgeAttempts: outcome.attempts });
  }
  const fallback = fallbackJudgement(ctx.signals);
  return applyJudgement(ctx, fallback, { source: fallback.verdict === 'continue' ? 'todo' : 'judge', verdict: fallback.verdict, category: fallback.category, reason: fallback.reason, failOpen: true, error: outcome.error, timedOut: outcome.timedOut === true, judgeAttempts: outcome.attempts });
}

function wokenRun(store: SqliteStateStore, sessionId: string, humanMessageId: string | undefined): boolean {
  const wake = readFinishWake(store, sessionId);
  return wake !== undefined && wake.dueAt === undefined && wake.humanMessageId === humanMessageId;
}

/**
 * Soft-stop check for a Bot chat turn that no goal owns. Cheap text and todo
 * signals decide whether a judge is asked at all; most turns end without one.
 */
export async function reviewUnboundFinish(host: FinishCheckHost, session: SessionRecord, signal?: AbortSignal, finalTurn = false): Promise<FinishGateResult | undefined> {
  const settings = readBotFinishSettings(host.store);
  if (!settings.finishCheckEnabled && !settings.wakeEnabled) return undefined;
  const state = runs.get(host.store)?.get(session.id);
  if (!state || untouchable(host.store, session, signal, finalTurn)) return undefined;
  const all = host.store.foldMessages(session.id);
  const run = all.filter(message => (message.seq ?? 0) > state.startSeq);
  const reply = textOf(run.findLast(message => message.role === 'assistant' && message.parts.some(part => part.type === 'text')));
  if (!reply.trim()) return undefined;
  const human = lastHumanMessage(all);
  const signals = finishSignals(reply, toolCallsOf(run));
  // A run started by a wake always gets judged: "still running" must arm the next wake even when worded tersely.
  if (wokenRun(host.store, session.id, human?.id)) signals.defer = true;
  if (!worthJudging(signals)) return undefined;
  const ctx: CheckContext = { host, session, settings, state, signals, reply, human };
  const spent = exhausted(ctx);
  // A spent run is not sent back again. A promise to report later may still need a wake.
  if (spent && !(signals.defer && settings.wakeEnabled)) {
    trace(ctx, { source: 'guard', verdict: 'stop', decision: 'allow', reason: spent });
    return { met: true };
  }
  return judged(ctx, signal);
}

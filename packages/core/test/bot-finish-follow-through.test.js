import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { builtinAgents } from '../dist/builtin-agents.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { bindGoalExecution, prepareGoalIntake, readGoalAttachments } from '../dist/bots/goals/runtime-host.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';
import { clearFinishRun, noteFinishRunStart, reviewUnboundFinish } from '../dist/bots/goals/finish-check.js';
import { readFinishWake, registerFinishWake, tickFinishWakes } from '../dist/bots/goals/finish-wake.js';
import { DEFAULT_BOT_FINISH_SETTINGS, readBotFinishSettings, writeBotFinishSettings } from '../dist/bots/goals/finish-settings.js';
import { isContinueNudge, isProgressQuery } from '../dist/bots/goals/followup.js';
import { endedWithAnswer, parseRunOutcome, runOutcomeFromEnd } from '../dist/session/run-outcome.js';

const BOT = 'b';

function openChat(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finish-follow-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({ title: 'Bot', mode: 'chat', agentId: 'general', metadata: { botId: BOT, canonicalBotChat: true } });
  const service = new BotGoalService(store, Date.now, session.id);
  const runs = [];
  const traces = [];
  const judgeCalls = [];
  const host = {
    store,
    isRunning: () => false,
    cancel() {},
    async run(id) { runs.push(id); },
    capabilities: () => ({ registeredTools: ['read_file'], enabledStrategies: ['direct', 'subagent'] }),
    emitTrace: (sessionId, event) => traces.push({ sessionId, ...event }),
    ...(options.judge ? { judge: async (input) => { judgeCalls.push(input); return options.judge(input); } } : {}),
  };
  async function say(text) {
    const message = store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
    requestHumanRun(store, session.id);
    await prepareGoalIntake(host, store.getSession(session.id));
    return message;
  }
  const steers = () => store.listUnclaimedInbox(session.id).map((item) => item.text);
  const live = () => store.getSession(session.id);
  return { dir, store, session, service, host, runs, traces, judgeCalls, say, steers, live };
}

function goalIn(chat, status, objective = '把登录失败提示改成中文') {
  const goal = chat.service.create({ botId: BOT, sessionId: chat.session.id, title: objective, objective });
  if (status === 'blocked') chat.service.block(BOT, goal.id, 'Execution interrupted');
  if (status === 'paused') chat.service.control(BOT, goal.id, 'pause');
  if (status === 'pending_review' || status === 'running') {
    const execution = chat.service.claim(BOT, goal.id, { strategy: 'subagent' });
    if (status === 'pending_review') chat.service.report(BOT, execution.id, { kind: 'candidate_completed', summary: '改完了', evidence: ['改完了'], verified: false });
  }
  return chat.service.get(BOT, goal.id);
}

test('a push to continue runs the recent unfinished goal in this turn [AC:bot-finish-follow-through#AC-1]', async (t) => {
  for (const [status, text] of [['blocked', '继续'], ['paused', '接着做'], ['pending_review', 'go on'], ['queued', '继续吧']]) {
    const chat = openChat(t);
    const goal = goalIn(chat, status);
    assert.equal(goal.status, status);
    const message = await chat.say(text);
    assert.equal(readGoalAttachments(chat.store, chat.session.id)[message.id], goal.id, `${status}: ${text}`);
    assert.equal(chat.service.list(BOT).length, 1, 'no new goal');
    assert.ok(!chat.steers().some((steer) => /ambiguous goal reference/.test(steer)), 'never asks which goal');
    assert.ok(chat.steers().some((steer) => steer.includes('[goal follow-up]')));

    assert.equal(bindGoalExecution(chat.host, chat.live()), true);
    const running = chat.service.get(BOT, goal.id);
    assert.equal(running.status, 'running');
    const execution = chat.service.executions(BOT, goal.id).find((item) => item.id === running.activeExecutionId);
    assert.equal(execution.sessionId, chat.session.id, 'the chat turn itself owns the execution');
    assert.equal(chat.live().metadata.botGoalId, goal.id);
    assert.deepEqual(readGoalAttachments(chat.store, chat.session.id), {});
  }
});

test('a progress question attaches an idle goal and only reports a busy one [AC:bot-finish-follow-through#AC-2]', async (t) => {
  for (const text of ['什么进度了', '跑完了吗', '干完了吗']) {
    assert.equal(isProgressQuery(text), true, text);
    const idle = openChat(t);
    const goal = goalIn(idle, 'blocked');
    const message = await idle.say(text);
    assert.equal(readGoalAttachments(idle.store, idle.session.id)[message.id], goal.id, text);
    assert.equal(bindGoalExecution(idle.host, idle.live()), true);
    assert.equal(idle.service.get(BOT, goal.id).status, 'running');
  }
  const busy = openChat(t);
  const running = goalIn(busy, 'running');
  await busy.say('什么进度了');
  assert.deepEqual(readGoalAttachments(busy.store, busy.session.id), {});
  assert.equal(busy.service.get(BOT, running.id).attempts, 1, 'not started twice');
  assert.ok(busy.steers().some((steer) => steer.includes('[goal status]') && steer.includes('do not start duplicate work')));

  const paused = openChat(t);
  const held = goalIn(paused, 'paused');
  await paused.say('什么进度了');
  assert.equal(paused.service.get(BOT, held.id).status, 'paused', 'a question does not undo a pause');
});

test('small talk, unrelated questions and new analysis never attach to an old goal [AC:bot-finish-follow-through#AC-3]', async (t) => {
  for (const text of ['你好', '你好吗？', '谢谢', '今天天气怎么样？', '什么是闭包？', '继续吗？', '顺便帮我分析一下报错日志', '看看这段代码为什么报错']) {
    assert.equal(isContinueNudge(text) || isProgressQuery(text), false, text);
    const chat = openChat(t);
    const goal = goalIn(chat, 'blocked');
    await chat.say(text);
    assert.deepEqual(readGoalAttachments(chat.store, chat.session.id), {}, text);
    assert.equal(chat.service.list(BOT).length, 1, `${text}: no new goal`);
    assert.equal(chat.service.get(BOT, goal.id).status, 'blocked', text);
  }

  const empty = openChat(t);
  await empty.say('继续');
  assert.deepEqual(empty.service.list(BOT), []);
  assert.ok(!empty.steers().some((steer) => /ambiguous goal reference|Ask which goal/.test(steer)));
  assert.ok(empty.steers().some((steer) => steer.startsWith('[follow-up]')));

  const stale = openChat(t);
  const threeDaysAgo = () => Date.now() - 3 * 86_400_000;
  const old = new BotGoalService(stale.store, threeDaysAgo, stale.session.id).create({ botId: BOT, sessionId: stale.session.id, title: '旧任务', objective: '旧任务' });
  await stale.say('什么进度了');
  assert.deepEqual(readGoalAttachments(stale.store, stale.session.id), {}, 'a goal untouched for days is not picked up');
  assert.equal(stale.service.get(BOT, old.id).attempts, 0);

  const moved = openChat(t);
  goalIn(moved, 'blocked');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await moved.say('什么是闭包？');
  moved.store.appendMessage(moved.session.id, 'assistant', [{ type: 'text', text: '闭包是函数和它引用的外部变量。' }]);
  moved.store.setDaemonControl(`session.humanContinuation:${moved.session.id}`, { pending: [] });
  await moved.say('继续');
  assert.deepEqual(readGoalAttachments(moved.store, moved.session.id), {}, 'the chat moved on to another topic');

  const off = openChat(t);
  writeBotFinishSettings(off.store, { followupAttachEnabled: false });
  goalIn(off, 'queued');
  await off.say('什么进度了');
  assert.deepEqual(readGoalAttachments(off.store, off.session.id), {});
});

test('a goal that cannot start again tells the turn why [AC:bot-finish-follow-through#AC-12]', async (t) => {
  const chat = openChat(t);
  chat.service.updateSettings({ maxAttempts: 1 });
  const goal = goalIn(chat, 'pending_review');
  await chat.say('继续');
  assert.equal(bindGoalExecution(chat.host, chat.live()), true, 'the chat still answers');
  const stopped = chat.service.get(BOT, goal.id);
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.blockedReason, 'Attempt limit reached');
  assert.ok(chat.steers().some((steer) => steer.includes('Attempt limit reached') && steer.includes('could not be started')));
});

test('intake records the classification and why a message was not turned into goal work [AC:bot-finish-follow-through#AC-14]', async (t) => {
  const chat = openChat(t);
  await chat.say('顺便帮我分析一下报错日志');
  await chat.say('这个接口稳定吗？');
  await chat.say('请修复登录超时');
  const goal = chat.service.list(BOT)[0];
  chat.service.block(BOT, goal.id, 'Execution interrupted');
  chat.store.setDaemonControl(`session.humanContinuation:${chat.session.id}`, { pending: [] });
  const followup = await chat.say('继续');
  const intake = chat.traces.filter((trace) => trace.kind === 'goal_intake').map((trace) => trace.payload);
  assert.equal(intake.length, 4);
  assert.deepEqual(intake[0].intents, [{ kind: 'chat' }]);
  assert.deepEqual(intake[0].downgrades, ['self_contained']);
  assert.deepEqual(intake[1].downgrades, ['question_mark']);
  assert.deepEqual(intake[2].intents, [{ kind: 'new_goal' }]);
  assert.equal(intake[2].createdGoalId, goal.id);
  assert.deepEqual(intake[2].downgrades, []);
  assert.equal(intake[3].messageId, followup.id);
  assert.deepEqual(intake[3].followup, { kind: 'continue', goalId: goal.id, action: 'attach', reason: 'goal_blocked' });
});

// ---- goal-less turn: soft-stop check -------------------------------------

function openRun(t, verdict, options = {}) {
  const chat = openChat(t, { judge: typeof verdict === 'function' ? verdict : async () => JSON.stringify(verdict) });
  chat.store.appendMessage(chat.session.id, 'user', [{ type: 'text', text: options.request ?? '把三个配置文件都改掉' }]);
  options.before?.(chat);
  noteFinishRunStart(chat.store, chat.session.id);
  t.after(() => clearFinishRun(chat.store, chat.session.id));
  let calls = 0;
  const tool = (name = 'edit_file', input = {}) => {
    calls += 1;
    chat.store.appendMessage(chat.session.id, 'assistant', [{ type: 'tool_call', toolCallId: `c${calls}`, name, input }]);
    chat.store.appendMessage(chat.session.id, 'tool', [{ type: 'tool_result', toolCallId: `c${calls}`, name, ok: true, content: 'ok' }]);
  };
  const reply = (text) => chat.store.appendMessage(chat.session.id, 'assistant', [{ type: 'text', text }]);
  const check = (signal, finalTurn) => reviewUnboundFinish(chat.host, chat.live(), signal, finalTurn);
  const checks = () => chat.traces.filter((trace) => trace.kind === 'finish_check').map((trace) => trace.payload);
  return { ...chat, tool, reply, check, checks };
}

const CONTINUE = { verdict: 'continue', category: 'promised_not_done', reason: 'Two files are still unchanged', nextStep: 'Edit the remaining two files' };

test('a goal-less turn that stopped early is sent back to work [AC:bot-finish-follow-through#AC-4]', async (t) => {
  for (const text of ['第一个文件改好了，接下来我会继续修改剩余的两个文件。', '第一个文件改好了。要不要我继续改另外两个？']) {
    const run = openRun(t, CONTINUE);
    run.tool();
    run.reply(text);
    const result = await run.check();
    assert.equal(result.met, false, text);
    assert.equal(result.action, 'continue');
    assert.match(result.systemMessage, /^\[finish check\]/);
    assert.match(result.systemMessage, /Edit the remaining two files/);
  }

  const todo = openRun(t, { ...CONTINUE, category: 'open_todo' });
  todo.tool('TodoWrite', { items: [{ content: '改 a.json', status: 'completed', activeForm: '改 a' }, { content: '改 b.json', status: 'pending', activeForm: '改 b' }] });
  todo.reply('a.json 已经改好。');
  const result = await todo.check();
  assert.equal(result.action, 'continue');
  assert.match(result.systemMessage, /改 b\.json/);
  assert.equal(todo.judgeCalls.length, 1);
  assert.deepEqual(JSON.parse(todo.judgeCalls[0].user).openTodos, ['改 b.json']);
});

test('answered requests, real needs for the user and stale todos end normally [AC:bot-finish-follow-through#AC-5]', async (t) => {
  const offer = openRun(t, { verdict: 'stop', category: 'optional_offer', reason: 'Answered; the offer is optional' });
  offer.tool();
  offer.reply('三个文件都改好了。要不要我顺便加一个测试？');
  assert.deepEqual(await offer.check(), { met: true });

  for (const text of ['需要你先登录 GitHub，登录后告诉我，我继续推送。', '删除生产库是不可逆操作，请确认后我再执行。', '按你说的先讨论方案：你希望我先改哪一部分？']) {
    const needs = openRun(t, { verdict: 'stop', category: 'needs_user', reason: 'Only the user can do this' });
    needs.reply(text);
    assert.deepEqual(await needs.check(), { met: true }, text);
    assert.equal(needs.checks().at(-1).decision, 'allow');
  }

  const plain = openRun(t, CONTINUE);
  plain.reply('闭包是函数和它引用的外部变量。');
  assert.equal(await plain.check(), undefined, 'an ordinary answer is not judged at all');
  assert.equal(plain.judgeCalls.length, 0);

  const stale = openRun(t, CONTINUE, {
    before(chat) {
      chat.store.appendMessage(chat.session.id, 'assistant', [{ type: 'tool_call', toolCallId: 'old', name: 'TodoWrite', input: { items: [{ content: '上周没做完的事', status: 'pending', activeForm: '做' }] } }]);
      chat.store.updateSession(chat.session.id, { todo: [{ content: '上周没做完的事', status: 'pending', activeForm: '做' }] });
    },
  });
  stale.reply('42');
  assert.equal(await stale.check(), undefined, 'todos left by earlier runs do not count');
  assert.equal(stale.judgeCalls.length, 0);
});

test('being sent back is capped, stops without progress and never reopens a protected end [AC:bot-finish-follow-through#AC-6]', async (t) => {
  const idle = openRun(t, CONTINUE);
  idle.tool();
  idle.reply('接下来我会继续修改剩余的两个文件。');
  assert.equal((await idle.check()).action, 'continue');
  idle.reply('好的，接下来我会继续修改。');
  assert.deepEqual(await idle.check(), { met: true }, 'no tool call since the push back');
  assert.equal(idle.judgeCalls.length, 1);
  assert.equal(idle.checks().at(-1).reason, 'no_progress');

  const capped = openRun(t, CONTINUE);
  for (let round = 0; round < DEFAULT_BOT_FINISH_SETTINGS.maxContinuations; round += 1) {
    capped.tool();
    capped.reply('接下来我会继续修改剩余的文件。');
    assert.equal((await capped.check()).action, 'continue', `round ${round}`);
  }
  capped.tool();
  capped.reply('接下来我会继续修改剩余的文件。');
  assert.deepEqual(await capped.check(), { met: true });
  assert.equal(capped.checks().at(-1).reason, 'continuation_cap');
  assert.equal(capped.judgeCalls.length, DEFAULT_BOT_FINISH_SETTINGS.maxContinuations);

  const guarded = openRun(t, CONTINUE);
  guarded.tool();
  guarded.reply('接下来我会继续修改剩余的两个文件。');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await guarded.check(aborted.signal), undefined, 'user abort');
  assert.equal(await guarded.check(undefined, true), undefined, 'turn limit');
  guarded.store.updateSession(guarded.session.id, { status: 'waiting_approval' });
  assert.equal(await guarded.check(), undefined, 'waiting for approval or an ask_user answer');
  guarded.store.updateSession(guarded.session.id, { status: 'running', metadata: { ...guarded.live().metadata, botGoalBudgetExceeded: { at: 1 } } });
  assert.equal(await guarded.check(), undefined, 'budget used up');
  assert.equal(guarded.judgeCalls.length, 0);
});

test('a failing finish judge is retried once, then the turn ends and the trace says so [AC:bot-finish-follow-through#AC-7]', async (t) => {
  for (const failure of [async () => { throw new Error('upstream 503'); }, async () => '{"intents":[]}']) {
    const run = openRun(t, failure);
    run.tool();
    run.reply('接下来我会继续修改剩余的两个文件。');
    assert.deepEqual(await run.check(), { met: true });
    assert.equal(run.judgeCalls.length, 2);
    const trace = run.checks().at(-1);
    assert.equal(trace.failOpen, true);
    assert.equal(trace.decision, 'allow');
    assert.equal(trace.judgeAttempts, 2);
    assert.ok(trace.error);
  }
});

test('every finish verdict is traced with verdict, reason, source, fail-open and count [AC:bot-finish-follow-through#AC-13]', async (t) => {
  const run = openRun(t, CONTINUE);
  run.tool();
  run.reply('接下来我会继续修改剩余的两个文件。');
  await run.check();
  const [trace] = run.checks();
  assert.equal(trace.source, 'judge');
  assert.equal(trace.verdict, 'continue');
  assert.equal(trace.decision, 'continue');
  assert.equal(trace.reason, CONTINUE.reason);
  assert.equal(trace.failOpen, false);
  assert.equal(trace.continuations, 1);
  assert.equal(trace.maxContinuations, DEFAULT_BOT_FINISH_SETTINGS.maxContinuations);
});

// ---- promise to report later ---------------------------------------------

const WAKE = { verdict: 'wake', category: 'deferred_report', reason: 'Remote training is still running' };
const PROMISE = '训练已经在远端启动，跑完后我再汇报结果。';

test('a promise to report later without any wait registers a wake that later runs the chat [AC:bot-finish-follow-through#AC-8]', async (t) => {
  const run = openRun(t, WAKE);
  run.tool('bash', { command: 'ssh gpu nohup train.sh' });
  run.reply(PROMISE);
  const before = Date.now();
  assert.deepEqual(await run.check(), { met: true });
  const wake = readFinishWake(run.store, run.session.id);
  assert.equal(wake.count, 1);
  assert.ok(wake.dueAt >= before + DEFAULT_BOT_FINISH_SETTINGS.wakeDelayMinutes * 60_000);
  const trace = run.checks().at(-1);
  assert.equal(trace.deferredWithoutWake, true);
  assert.equal(trace.wake, 'registered');

  run.store.updateSession(run.session.id, { status: 'idle' });
  tickFinishWakes(run.host, wake.dueAt - 1);
  assert.deepEqual(run.runs, [], 'not before it is due');
  tickFinishWakes(run.host, wake.dueAt + 1);
  assert.deepEqual(run.runs, [run.session.id]);
  assert.ok(run.steers().some((steer) => steer.startsWith('[follow-up wake 1/3]') && steer.includes('Check the real status now')));
  tickFinishWakes(run.host, wake.dueAt + 2);
  assert.deepEqual(run.runs, [run.session.id], 'a wake fires once');
  assert.ok(run.traces.some((item) => item.kind === 'finish_wake' && item.payload.event === 'fired'));

  // The woken run answers tersely; the next wake is still armed, twice as far out.
  run.reply('还没好。');
  const again = Date.now();
  assert.deepEqual(await run.check(), { met: true });
  const next = readFinishWake(run.store, run.session.id);
  assert.equal(next.count, 2);
  assert.ok(next.dueAt >= again + DEFAULT_BOT_FINISH_SETTINGS.wakeDelayMinutes * 2 * 60_000);
});

test('no second wake when a job, timer or wait already brings the chat back [AC:bot-finish-follow-through#AC-9]', async (t) => {
  const job = openRun(t, WAKE);
  job.store.createBackgroundJob({ sessionId: job.session.id, command: 'train.sh', status: 'running' });
  job.reply(PROMISE);
  assert.deepEqual(await job.check(), { met: true });
  assert.equal(readFinishWake(job.store, job.session.id), undefined);
  assert.equal(job.checks().at(-1).deferredWithoutWake, false);

  const timer = openRun(t, WAKE);
  timer.tool('cron_create', { once_at: '2026-11-11T00:00:00Z' });
  timer.reply(PROMISE);
  await timer.check();
  assert.equal(readFinishWake(timer.store, timer.session.id), undefined);
  assert.equal(timer.checks().at(-1).wake, 'already_registered');
});

test('wakes are capped and a newer user message cancels a pending one [AC:bot-finish-follow-through#AC-10]', async (t) => {
  const chat = openChat(t);
  const human = chat.store.appendMessage(chat.session.id, 'user', [{ type: 'text', text: '在远端跑训练' }]);
  const settings = readBotFinishSettings(chat.store);
  const input = { settings, humanMessageId: human.id, promise: PROMISE, reason: 'still running' };
  const delays = [];
  for (let round = 1; round <= settings.maxWakes; round += 1) {
    const decision = registerFinishWake(chat.store, chat.session.id, { ...input, now: 0 });
    assert.equal(decision.registered, true);
    assert.equal(decision.count, round);
    delays.push(decision.dueAt);
    tickFinishWakes(chat.host, decision.dueAt + 1);
  }
  assert.deepEqual(delays, [10, 20, 40].map((minutes) => minutes * 60_000), 'each wake waits twice as long');
  assert.equal(chat.runs.length, settings.maxWakes);
  const over = registerFinishWake(chat.store, chat.session.id, { ...input, now: 0 });
  assert.deepEqual({ registered: over.registered, reason: over.reason }, { registered: false, reason: 'wake_cap' });
  assert.equal(readFinishWake(chat.store, chat.session.id), undefined);

  const pending = registerFinishWake(chat.store, chat.session.id, { ...input, now: 0 });
  assert.equal(pending.count, 1, 'a fresh promise starts a new count');
  chat.store.appendMessage(chat.session.id, 'user', [{ type: 'text', text: '算了，先看别的' }]);
  tickFinishWakes(chat.host, pending.dueAt + 1);
  assert.equal(chat.runs.length, settings.maxWakes, 'the obsolete wake does not run the chat');
  assert.equal(readFinishWake(chat.store, chat.session.id), undefined);
  assert.ok(chat.traces.some((item) => item.kind === 'finish_wake' && item.payload.event === 'obsolete'));
});

test('finish settings save, survive a restart, reject bad values and switch the checks off [AC:bot-finish-follow-through#AC-15]', async (t) => {
  const chat = openChat(t);
  assert.deepEqual(readBotFinishSettings(chat.store), DEFAULT_BOT_FINISH_SETTINGS);
  assert.equal(DEFAULT_BOT_FINISH_SETTINGS.finishCheckEnabled && DEFAULT_BOT_FINISH_SETTINGS.wakeEnabled && DEFAULT_BOT_FINISH_SETTINGS.followupAttachEnabled, true, 'on by default');
  const saved = writeBotFinishSettings(chat.store, { maxContinuations: 4, wakeDelayMinutes: 30, maxWakes: 5 });
  assert.equal(saved.maxContinuations, 4);
  const reopened = new SqliteStateStore(join(chat.dir, 'state.db'));
  t.after(() => reopened.db.close());
  assert.deepEqual(readBotFinishSettings(reopened), saved);
  for (const bad of [{ maxContinuations: 0 }, { maxContinuations: 99 }, { wakeDelayMinutes: 0.5 }, { maxWakes: -1 }, { finishCheckEnabled: 'yes' }, { unknown: 1 }]) {
    assert.throws(() => writeBotFinishSettings(chat.store, bad), /Invalid|Unknown/, JSON.stringify(bad));
  }
  assert.deepEqual(readBotFinishSettings(chat.store), saved, 'a rejected save changes nothing');

  const noCheck = openRun(t, CONTINUE);
  writeBotFinishSettings(noCheck.store, { finishCheckEnabled: false });
  noCheck.tool();
  noCheck.reply('接下来我会继续修改剩余的两个文件。');
  assert.deepEqual(await noCheck.check(), { met: true }, 'not sent back when the check is off');

  const noWake = openRun(t, WAKE);
  writeBotFinishSettings(noWake.store, { wakeEnabled: false });
  noWake.reply(PROMISE);
  await noWake.check();
  assert.equal(readFinishWake(noWake.store, noWake.session.id), undefined);

  const allOff = openRun(t, CONTINUE);
  writeBotFinishSettings(allOff.store, { finishCheckEnabled: false, wakeEnabled: false });
  allOff.reply('接下来我会继续修改剩余的两个文件。');
  assert.equal(await allOff.check(), undefined);
  assert.equal(allOff.judgeCalls.length, 0);
});

// ---- turn limit -----------------------------------------------------------

test('a turn-limit end is its own reason and still counts as an answered end where a reply is delivered [AC:bot-finish-follow-through#AC-11]', () => {
  const limited = runOutcomeFromEnd({ reason: 'max_turns', sessionStatus: 'idle', answered: true });
  assert.deepEqual(limited, { kind: 'idle', reason: 'max_turns', answered: true });
  assert.deepEqual(parseRunOutcome(JSON.parse(JSON.stringify(limited))), limited);
  assert.equal(endedWithAnswer(limited), true);
  assert.equal(endedWithAnswer({ kind: 'idle', reason: 'end' }), true);
  assert.equal(endedWithAnswer({ kind: 'idle', reason: 'max_turns' }), false, 'cut off mid-work without a reply');
  assert.equal(endedWithAnswer({ kind: 'idle', reason: 'loop_guard' }), false);
  assert.equal(runOutcomeFromEnd({ reason: 'end', sessionStatus: 'idle', answered: true }).answered, undefined);
});

function turnLimitRuntime(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'finish-turn-limit-'));
  let step = 0;
  const lastTurns = [];
  const rt = new RawAgentRuntime({
    repoRoot: root, stateDir: join(root, 'state'),
    agents: [{ ...builtinAgents.find((agent) => agent.id === 'general'), allowedTools: ['fixture_step'] }],
    extraTools: [{ name: 'fixture_step', description: 'do one step', inputSchema: { type: 'object', properties: { n: { type: 'number' } } }, approvalMode: 'never', sideEffectLevel: 'none', async execute(_ctx, args) { return { ok: true, content: `step ${args.n} done` }; } }],
    modelAdapter: {
      name: 'turn-limit',
      async summarizeMessages() { return ''; },
      async completeText(input) {
        if (input.system.startsWith('Evaluate')) return options.judge(JSON.parse(input.user));
        return JSON.stringify({ intents: [{ kind: 'new_goal', text: options.request }] });
      },
      async runTurn(input) {
        step += 1;
        if (!input.tools?.length) { lastTurns.push(step); return { stopReason: 'end', assistantParts: [{ type: 'text', text: '做到第 23 步，还剩最后的校验没做。' }] }; }
        return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: `step-${step}`, name: 'fixture_step', input: { n: step } }] };
      },
    },
  });
  t.after(async () => { await rt.destroy(); rmSync(root, { recursive: true, force: true }); });
  const bot = rt.createBot({ name: 'turn-limit' });
  const sid = rt.openBot(bot.id).sessionId;
  rt.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  rt.mergeSessionMetadata(sid, { allowedTools: ['fixture_step'], allowedSkillNames: [], permissionMode: 'auto', maxTurns: 24 });
  const traces = () => readFileSync(join(root, 'state', 'traces', sid, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const goals = () => rt.store.getDaemonControl(`bot_goals:${bot.id}`)?.goals ?? [];
  return { rt, bot, sid, traces, goals, lastTurns };
}

test('a bound goal cut by the turn limit goes back to the queue and the chat says it is still working [AC:bot-finish-follow-through#AC-11] [AC:bot-finish-follow-through#AC-12] [AC:bot-finish-follow-through#AC-13]', { timeout: 60_000 }, async (t) => {
  const request = '请修复登录超时并完成校验';
  const fixture = turnLimitRuntime(t, {
    request,
    judge: (packet) => JSON.stringify({ met: false, advanced: true, reason: 'Final check not run', missing: ['run the final check'], evidenceRefs: packet.observations.filter((o) => o.ok).map((o) => o.ref) }),
  });
  fixture.rt.sendUserMessage(fixture.sid, request);
  await fixture.rt.runHumanSession(fixture.sid);

  const session = fixture.rt.store.getSession(fixture.sid);
  assert.deepEqual(session.metadata.outcome, { kind: 'idle', reason: 'max_turns', answered: true });
  assert.equal(fixture.lastTurns.length, 1, 'the forced last turn answered once');
  const [goal] = fixture.goals();
  assert.equal(goal.status, 'queued', 'the scheduler continues it within budget and attempts');
  assert.equal(goal.attempts, 1);
  assert.match(goal.nextStep, /final check/);
  const notices = fixture.rt.store.foldMessages(fixture.sid).filter((message) => message.role === 'system').flatMap((message) => message.parts.map((part) => part.text ?? ''));
  assert.ok(notices.some((text) => text.startsWith('[goal-continuing] ') && text.includes('step limit') && text.includes('attempt 1 of 20')), notices.join('\n'));

  await new Promise((resolve) => setTimeout(resolve, 50));
  const traces = fixture.traces();
  const verdicts = traces.filter((trace) => trace.kind === 'goal_eval' && trace.payload.source === 'bot_goal_completion');
  assert.ok(verdicts.length >= 1);
  assert.equal(verdicts[0].payload.met, false);
  assert.equal(verdicts[0].payload.failOpen, false);
  assert.equal(verdicts[0].payload.goalId, goal.id);
  assert.match(verdicts[0].payload.reason, /final check/);
  assert.ok(traces.some((trace) => trace.kind === 'goal_eval' && trace.payload.source === 'bot_goal_before_end' && trace.payload.decision === 'turn_limit'));
  assert.ok(traces.some((trace) => trace.kind === 'goal_intake' && trace.payload.createdGoalId === goal.id));
});

test('a completion judge that fails is traced as let through and a turn-limit result is not parked for review [AC:bot-finish-follow-through#AC-12] [AC:bot-finish-follow-through#AC-13]', { timeout: 60_000 }, async (t) => {
  const request = '请修复登录超时并完成校验';
  const fixture = turnLimitRuntime(t, { request, judge: () => { throw new Error('judge down'); } });
  fixture.rt.store.setDaemonControl(`bot_multi_goal_settings:${fixture.sid}`, { maxAttempts: 1 });
  fixture.rt.sendUserMessage(fixture.sid, request);
  await fixture.rt.runHumanSession(fixture.sid);
  const [goal] = fixture.goals();
  assert.equal(goal.status, 'blocked', 'limits used up: it stops instead of looping');
  assert.equal(goal.blockedReason, 'Attempt limit reached');
  const notices = fixture.rt.store.foldMessages(fixture.sid).filter((message) => message.role === 'system').flatMap((message) => message.parts.map((part) => part.text ?? ''));
  assert.ok(notices.some((text) => text.startsWith('[goal update] Blocked:') && text.includes('Attempt limit reached')), notices.join('\n'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const failed = fixture.traces().filter((trace) => trace.kind === 'goal_eval' && trace.payload.source === 'bot_goal_completion');
  assert.ok(failed.length >= 1);
  assert.equal(failed[0].payload.failOpen, true);
  assert.match(failed[0].payload.error, /judge down/);
});

test('a goal-less bot turn that promises more work is pushed on by the runtime end to end [AC:bot-finish-follow-through#AC-4]', { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'finish-e2e-'));
  let step = 0;
  let judged = 0;
  const rt = new RawAgentRuntime({
    repoRoot: root, stateDir: join(root, 'state'),
    agents: [{ ...builtinAgents.find((agent) => agent.id === 'general'), allowedTools: ['fixture_step'] }],
    extraTools: [{ name: 'fixture_step', description: 'do one step', inputSchema: { type: 'object', properties: {} }, approvalMode: 'never', sideEffectLevel: 'none', async execute() { return { ok: true, content: 'done' }; } }],
    modelAdapter: {
      name: 'finish-e2e',
      async summarizeMessages() { return ''; },
      async completeText(input) {
        if (!input.system.startsWith('You review the last reply')) return '{"intents":[]}';
        judged += 1;
        return JSON.stringify(JSON.parse(input.user).assistantReply.includes('接下来') ? CONTINUE : { verdict: 'stop', category: 'done', reason: 'Finished' });
      },
      async runTurn() {
        step += 1;
        if (step === 1) return { stopReason: 'end', assistantParts: [{ type: 'text', text: '我看了一下，接下来我会检查剩余的两个文件。' }] };
        if (step === 2) return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: 'check', name: 'fixture_step', input: {} }] };
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: '两个文件都检查完了，没有问题。' }] };
      },
    },
  });
  t.after(async () => { await rt.destroy(); rmSync(root, { recursive: true, force: true }); });
  const bot = rt.createBot({ name: 'finish-e2e' });
  const sid = rt.openBot(bot.id).sessionId;
  rt.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  rt.mergeSessionMetadata(sid, { allowedTools: ['fixture_step'], allowedSkillNames: [], permissionMode: 'auto' });
  rt.sendUserMessage(sid, '看看这两个文件有没有问题');
  await rt.runHumanSession(sid);
  assert.equal(step, 3, 'the runtime pushed the turn on instead of ending after the promise');
  assert.equal(judged, 1, 'the finished reply has no cue and is not judged');
  assert.equal(rt.store.getDaemonControl(`bot_goals:${bot.id}`)?.goals?.length ?? 0, 0, 'no goal was created for it');
  assert.deepEqual(rt.store.getSession(sid).metadata.outcome, { kind: 'idle', reason: 'end' });
  const last = rt.store.foldMessages(sid).findLast((message) => message.role === 'assistant');
  assert.equal(last.parts.find((part) => part.type === 'text').text, '两个文件都检查完了，没有问题。');
});

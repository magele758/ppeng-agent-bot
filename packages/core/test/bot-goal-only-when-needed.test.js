import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { bindGoalExecution, prepareGoalIntake, settleGoalExecution } from '../dist/bots/goals/runtime-host.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';
import { tickBotGoals } from '../dist/bots/goals/scheduler.js';
import { selectGoalRoute } from '../dist/bots/goals/routing.js';

const ANALYSIS = ['顺便帮我分析一下报错日志', '看看这段代码为什么报错'];

function openChat(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-only-when-needed-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({
    title: 'Bot',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'b', canonicalBotChat: true }
  });
  const service = new BotGoalService(store, Date.now, session.id);
  const runs = [];
  const host = {
    store,
    isRunning: () => false,
    cancel() {},
    async run(id) { runs.push(id); },
    capabilities: () => ({ registeredTools: ['spawn_subagent', 'read_file'], enabledStrategies: ['direct', 'subagent'] })
  };
  async function say(text) {
    store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
    requestHumanRun(store, session.id);
    await prepareGoalIntake(host, store.getSession(session.id));
  }
  return { store, session, service, host, runs, say };
}

test('analysis the bot can finish itself does not become a goal or a child task [AC:bot-goal-only-when-needed#AC-1]', async (t) => {
  const chat = openChat(t);
  for (const text of ANALYSIS) await chat.say(text);
  assert.deepEqual(chat.service.list('b'), []);
  await tickBotGoals(chat.host);
  assert.deepEqual(chat.runs, []);
});

test('a stated delivery still stays an in-progress goal [AC:bot-goal-only-when-needed#AC-2]', async (t) => {
  const chat = openChat(t);
  await chat.say('把登录失败提示改成中文，完成结果是用户看到中文错误');
  await chat.say('请修复登录超时');
  const goals = chat.service.list('b');
  assert.equal(goals.length, 2);
  for (const goal of goals) assert.equal(goal.status, 'queued');
  assert.ok(goals.some((goal) => goal.objective.includes('完成结果是用户看到中文错误')));
  assert.ok(goals.some((goal) => goal.objective.includes('修复登录超时')));
});

test('a handled goal does not start another child task for the same work [AC:bot-goal-only-when-needed#AC-3]', async (t) => {
  const chat = openChat(t);
  const goal = chat.service.create({
    botId: 'b',
    sessionId: chat.session.id,
    title: '分析日志',
    objective: '看看这段代码为什么报错'
  });
  chat.store.appendMessage(chat.session.id, 'assistant', [{ type: 'text', text: '空指针来自登录回调，原因已经说明。' }]);
  chat.store.updateSession(chat.session.id, {
    metadata: { ...chat.store.getSession(chat.session.id).metadata, botGoalId: goal.id }
  });
  bindGoalExecution(chat.host, chat.store.getSession(chat.session.id));
  const afterBind = chat.store.getSession(chat.session.id);
  assert.equal(afterBind.metadata.botGoalExecutionId, undefined);
  await tickBotGoals(chat.host);
  assert.deepEqual(chat.runs, []);
  const saved = chat.service.get('b', goal.id);
  assert.equal(saved.status, 'queued');
  assert.equal(saved.attempts, 0);
});

test('unfinished work and an explicit handoff still continue [AC:bot-goal-only-when-needed#AC-4]', async (t) => {
  const chat = openChat(t);
  const unfinished = chat.service.create({
    botId: 'b',
    sessionId: chat.session.id,
    title: '修登录',
    objective: '把登录失败提示改成中文，完成结果是用户看到中文错误'
  });
  const first = chat.service.claim('b', unfinished.id, { strategy: 'direct' });
  chat.service.updateExecution('b', first.id, { sessionId: chat.session.id });
  chat.store.updateSession(chat.session.id, {
    metadata: {
      ...chat.store.getSession(chat.session.id).metadata,
      botGoalId: unfinished.id,
      botGoalExecutionId: first.id,
      botGoalScopeSessionId: chat.session.id
    }
  });
  chat.store.appendMessage(chat.session.id, 'assistant', [{ type: 'text', text: '中文提示还没改完。' }]);
  await settleGoalExecution({
    ...chat.host,
    judge: async () => JSON.stringify({ met: false, advanced: true, reason: '中文提示还没改完', evidence: [] })
  }, chat.session.id);
  assert.equal(chat.service.get('b', unfinished.id).status, 'queued');
  await tickBotGoals(chat.host);
  assert.equal(chat.runs.length, 1);
  assert.equal(chat.service.get('b', unfinished.id).attempts, 2);
  assert.ok(chat.service.get('b', unfinished.id).evidence.length >= 0);

  const capabilities = { registeredTools: ['spawn_subagent'], enabledStrategies: ['direct', 'subagent'] };
  assert.equal(selectGoalRoute({ task: '分析一下报错日志' }, capabilities).strategy, 'direct');
  assert.equal(selectGoalRoute({ task: '把这个分析拆成子任务并行做' }, capabilities).strategy, 'subagent');
  assert.equal(selectGoalRoute({ task: '实现登录失败的中文提示' }, capabilities).strategy, 'direct');
});

test('status and response preferences keep the existing work [AC:bot-watch-work-continuity#AC-1]',async t=>{
 const chat=openChat(t);
 const goal=chat.service.create({botId:'b',sessionId:chat.session.id,title:'修登录',objective:'修复登录超时并完成测试'});
 for(const text of ['好了吗？','进度怎么样？','回复简短一点，只说结论','以后用中文回答'])await chat.say(text);
 assert.deepEqual(chat.service.list('b').map(g=>g.id),[goal.id]);
});

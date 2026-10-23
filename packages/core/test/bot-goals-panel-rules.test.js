import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
import { prepareGoalIntake } from '../dist/bots/goals/runtime-host.js';
import { requestHumanRun } from '../dist/session/human-continuation.js';
import { classifyGoalIntents } from '../dist/bots/goals/intake.js';

const RECALL = '这个功能可以给ai-agent-node和ppeng-agent-core都加一下，2个应该都没有，你跟我复述一下ai-agent-node和ppeng-agent-core的开发规则先，我先看看你还记得不';
const SURVEY = '现在ppeng-agent-core又加了很多提交，特别是bot room这一块，看看新增的特性有什么可以搬';
const PARAPHRASES = [
  '你先复述一下开发规则，我先看看你还记不记得',
  '讨论一下 bot room 新增特性有什么可以借鉴',
];
const MULTI = '请同时做完两件独立的事：把登录失败提示改成中文，完成结果是用户看到中文错误；把退出按钮移到页面右上角，完成结果是按钮出现在右上角。';
const IN_PROGRESS = new Set(['queued', 'running', 'waiting', 'blocked', 'paused']);

function openChat(t, judge) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-panel-rules-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({
    title: 'Bot',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'b', canonicalBotChat: true },
  });
  const service = new BotGoalService(store, Date.now, session.id);
  const host = {
    store,
    isRunning: () => false,
    cancel() {},
    async run() {},
    capabilities: () => ({ registeredTools: [], enabledStrategies: ['direct'] }),
    ...(judge ? { judge } : {}),
  };
  async function say(text) {
    store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
    requestHumanRun(store, session.id);
    await prepareGoalIntake(host, store.getSession(session.id));
  }
  return { session, service, say };
}

function titles(service) {
  return service.list('b').map((goal) => goal.title);
}

test('asking, discussing, or checking memory does not become a goal [AC:bot-goals-panel-rules#AC-1]', async (t) => {
  const plain = openChat(t);
  for (const text of [RECALL, SURVEY, ...PARAPHRASES]) await plain.say(text);
  assert.deepEqual(plain.service.list('b'), []);

  const judged = openChat(t, async (input) => {
    const body = JSON.parse(input.user);
    return JSON.stringify({ intents: [{ kind: 'new_goal', text: body.text }] });
  });
  await judged.say(RECALL);
  await judged.say(SURVEY);
  assert.deepEqual(judged.service.list('b'), []);
});

test('an open question does not add a blocked goal or block goals already in this chat [AC:bot-goals-panel-rules#AC-2]', async (t) => {
  const plain = openChat(t);
  const existing = plain.service.create({
    botId: 'b',
    sessionId: plain.session.id,
    title: '修登录',
    objective: '把登录失败提示改成中文，完成结果是用户看到中文错误',
  });
  plain.service.claim('b', existing.id, { strategy: 'direct' });
  await plain.say(RECALL);
  await plain.say(SURVEY);
  assert.deepEqual(titles(plain.service), ['修登录']);
  assert.equal(plain.service.get('b', existing.id).status, 'running');
  assert.equal(plain.service.get('b', existing.id).blockedReason, undefined);
  assert.equal(plain.service.list('b').some((goal) => goal.status === 'blocked'), false);

  const judged = openChat(t, async (input) => {
    const body = JSON.parse(input.user);
    const goalId = judged.service.list('b')[0]?.id;
    return JSON.stringify({ intents: [{ kind: 'amend_goal', goalId, text: body.text }] });
  });
  const running = judged.service.create({
    botId: 'b',
    sessionId: judged.session.id,
    title: '修登录',
    objective: '把登录失败提示改成中文，完成结果是用户看到中文错误',
  });
  judged.service.claim('b', running.id, { strategy: 'direct' });
  await judged.say(RECALL);
  const after = judged.service.get('b', running.id);
  assert.equal(after.status, 'running');
  assert.equal(after.blockedReason, undefined);
  assert.deepEqual(after.constraints, []);
  assert.deepEqual(titles(judged.service), ['修登录']);
});

test('several stated outcomes each stay in progress [AC:bot-goals-panel-rules#AC-3]', async (t) => {
  const { service, say } = openChat(t);
  await say(MULTI);
  const goals = service.list('b');
  assert.equal(goals.length, 2);
  const login = goals.find((goal) => goal.objective.includes('登录失败提示'));
  const button = goals.find((goal) => goal.objective.includes('退出按钮'));
  assert.ok(login);
  assert.match(login.objective, /完成结果是用户看到中文错误/);
  assert.ok(button);
  assert.match(button.objective, /完成结果是按钮出现在右上角/);
  for (const goal of goals) {
    assert.ok(IN_PROGRESS.has(goal.status), goal.status);
    assert.equal(goal.status, 'queued');
    assert.notEqual(goal.status, 'completed');
    assert.notEqual(goal.status, 'cancelled');
    assert.notEqual(goal.status, 'failed');
  }
});

test('room intake still classifies an open question as work; only the bot chat drops it', async () => {
  const intents = await classifyGoalIntents(RECALL, []);
  assert.equal(intents[0].kind, 'new_goal');
  assert.equal((await classifyGoalIntents(SURVEY, []))[0].kind, 'new_goal');
});

test('a stated task is still admitted, and failed verification can still block it', async (t) => {
  const { service, say } = openChat(t);
  await say('请修复登录超时');
  await say('把退出按钮移到右上角，完成结果是按钮在右上角');
  const goals = service.list('b');
  assert.equal(goals.length, 2);
  for (const goal of goals) assert.equal(goal.status, 'queued');
  const execution = service.claim('b', goals[0].id, { strategy: 'direct' });
  service.report('b', execution.id, { kind: 'candidate_completed', summary: 'done', verified: false, evidence: [] });
  assert.equal(service.get('b', goals[0].id).status, 'blocked');
  assert.equal(service.get('b', goals[1].id).status, 'queued');
});

test('a named pause still pauses only that goal and keeps the other requested task', async (t) => {
  const { service, session, say } = openChat(t);
  const deploy = service.create({ botId: 'b', sessionId: session.id, title: '部署', objective: '部署' });
  service.claim('b', deploy.id, { strategy: 'direct' });
  await say('暂停部署，先修登录');
  assert.equal(service.get('b', deploy.id).status, 'paused');
  const added = service.list('b').find((goal) => goal.id !== deploy.id);
  assert.ok(added);
  assert.match(added.objective, /先修登录/);
  assert.equal(added.status, 'queued');
  assert.notEqual(added.status, 'blocked');
});

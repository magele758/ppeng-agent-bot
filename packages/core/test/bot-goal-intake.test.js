import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoalMessage } from '../dist/bots/goals/intake.js';

test('progress questions do not become independent work [AC:bot-multi-goal-coordination#AC-2]', () => {
  assert.equal(classifyGoalMessage('现在部署进度怎么样？').kind, 'query');
  assert.equal(classifyGoalMessage('What is the status of deployment?').kind, 'query');
});
test('explicit constraints and ambiguous controls preserve their target semantics [AC:bot-multi-goal-coordination#AC-3] [AC:bot-multi-goal-coordination#AC-4]', () => {
  assert.deepEqual(classifyGoalMessage('[goal:g-1] 登录页别改样式'), {kind:'amend_goal',goalId:'g-1',text:'登录页别改样式'});
  assert.equal(classifyGoalMessage('那个先停一下').kind, 'pause');
  assert.equal(classifyGoalMessage('那个先停一下').goalId, undefined);
});
test('new independent work stays new, while casual conversation creates no goals [AC:bot-multi-goal-coordination#AC-1]', () => {
  assert.equal(classifyGoalMessage('顺便帮我分析一下报错日志').kind, 'new_goal');
  assert.equal(classifyGoalMessage('谢谢').kind, 'chat');
});

test('questions and negations about control never cancel active work', () => {
  for (const text of ['这个能取消吗？', 'Can I cancel deployment?', '不要取消部署', '解释一下如何暂停', 'Add a cancel button', '帮我实现取消部署的功能', '分析暂停的原因']) {
    assert.ok(!['cancel', 'pause', 'resume'].includes(classifyGoalMessage(text).kind), text);
  }
});
test('mixed messages resolve named goals and preserve independent new work', async () => {
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const goals = [{ id: 'g-deploy', title: '部署', status: 'running' }, { id: 'g-login', title: '登录', status: 'running' }];
  assert.deepEqual((await classifyGoalIntents('暂停部署，先修登录', goals)).map(i => [i.kind, i.goalId]), [['pause', 'g-deploy'], ['new_goal', undefined]]);
  assert.deepEqual((await classifyGoalIntents('部署进度如何；另外分析报错', goals)).map(i => i.kind), ['query', 'new_goal']);
  assert.equal((await classifyGoalIntents('提高登录的优先级', goals))[0].kind, 'reprioritize');
});
test('semantic proposals cannot invent targets, rewrite explicit targets, or convert questions into cancellation', async () => {
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const goals = [{ id: 'g-1', title: '登录', status: 'running' }];
  const bad = async () => JSON.stringify({ intents: [{ kind: 'amend_goal', goalId: 'other', text: '别改样式' }] });
  assert.equal((await classifyGoalIntents('[goal:g-1] 别改样式', goals, bad))[0].kind, 'amend_goal');
  assert.equal((await classifyGoalIntents('能取消吗', goals, async () => ({ intents: [{ kind: 'cancel', goalId: 'g-1', text: '取消' }] })))[0].kind, 'chat');
  assert.equal((await classifyGoalIntents('检查日志', goals, async () => { throw new Error('offline'); }))[0].kind, 'new_goal');
  const valid = await classifyGoalIntents('把登录方式改成邮箱', goals, async () => ({ intents: [{ kind: 'amend_goal', goalId: 'g-1', text: '把登录方式改成邮箱' }] }));
  assert.equal(valid[0].goalId, 'g-1');
  assert.equal(valid[0].kind, 'amend_goal');
});


test('judge input is bounded and a hanging judge falls back without losing work', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const goals = Array.from({ length: 70 }, (_, i) => ({ id: `g-${i}`, title: 'x'.repeat(500), status: 'running' }));
  let signal;
  const pending = classifyGoalIntents('检查日志', goals, async input => {
    assert.equal(input.goals.length, 50);
    assert.equal(input.goals[0].title.length, 300);
    signal = input.signal;
    return new Promise(() => {});
  });
  t.mock.timers.tick(60001);
  const result=await pending;
  assert.equal(result[0].kind, 'new_goal');
  assert.equal(signal.aborted, true);
});

test('coordination wording stays attached to the deliverables [AC:bot-multi-goal-coordination#AC-1]', async () => {
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const text = '请同时完成两件互相独立的事。\n第一件：创建 alpha.json。\n第二件：创建 beta.json。\n两件事并行推进。不要把两件事收成一个目标。';
  const intents = await classifyGoalIntents(text, []);
  assert.deepEqual(intents.filter(intent => intent.kind === 'new_goal').map(intent => intent.text), ['第一件：创建 alpha.json。', '第二件：创建 beta.json。']);
});

test('an explicit goal id keeps an added requirement on that goal [AC:bot-multi-goal-coordination#AC-3]', async () => {
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const goals = [{ id: 'goal_alpha', title: '创建 alpha.json', status: 'paused' }, { id: 'goal_beta', title: '创建 beta.json', status: 'running' }];
  const text = '追加要求：目标 goal_alpha 的结果 JSON 必须额外包含 "extra":"live"。已完成的写入不要重做，只补上这个字段并重新核对。';
  const intents = await classifyGoalIntents(text, goals);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'amend_goal');
  assert.equal(intents[0].goalId, 'goal_alpha');
  assert.match(intents[0].text, /extra/);
});

test('dragged file bodies are not separate goals', async () => {
  const { classifyGoalIntents } = await import('../dist/bots/goals/intake.js');
  const fenced = [
    '只发给这个 Bot',
    '«external source=attachment label=a.txt»',
    'alpha-file-sentence',
    '«end external»',
    '«external source=attachment label=pack/readme.txt»',
    'alpha-folder-sentence',
    '«end external»'
  ].join('\n');
  const intents = await classifyGoalIntents(fenced, []);
  assert.deepEqual(intents.map((intent) => [intent.kind, intent.text]), [['new_goal', '只发给这个 Bot']]);
  const onlyFence = fenced.slice(fenced.indexOf('«'));
  assert.equal((await classifyGoalIntents(onlyFence, []))[0].kind, 'chat');
});

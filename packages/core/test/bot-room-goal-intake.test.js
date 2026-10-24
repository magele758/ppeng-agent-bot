import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeRoomAction,
  intakeRoomMessage,
  readRoomGoals,
  writeRoomGoals,
} from '../dist/rooms/room-goals.js';
import { checkpointRoomTask } from '../dist/rooms/room-tasks.js';

const roomId = 'room-1';
const members = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'gamma', name: 'Gamma' },
];

function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
  const writes = [];
  return {
    writes,
    getDaemonControl(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    setDaemonControl(key, value) {
      writes.push(key);
      data.set(key, structuredClone(value));
    },
  };
}

function goal(id, title, progress, status = 'running') {
  return {
    id, roomId, title, status, constraints: [], revision: 1, priority: 0, progress, createdAt: 't0', updatedAt: 't0',
  };
}

function task(id, goalId, title, assigneeBotId, summary) {
  return {
    id, goalId, goalRevision: 1, title, assigneeBotId, blockedBy: [], status: 'running', summary, materialIds: [], updatedAt: 't0',
  };
}

function action(id, goalId, taskId, botId, summary, recallable) {
  return { id, goalId, taskId, botId, summary, recallable, goalRevision: 1, status: 'running' };
}

test('a progress question is answered from the board and does not change the work [AC:bot-room-goal-intake#AC-1]', async () => {
  const store = memoryStore();
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到鉴权')],
    tasks: [task('t-beta', 'g-api', '写接口', 'beta', '写到鉴权')],
    actions: [],
    stoppedBotIds: [],
  });
  const before = JSON.stringify(readRoomGoals(store, roomId));
  store.writes.length = 0;
  const progress = await intakeRoomMessage(store, { roomId, text: '现在做到哪一步了？', members });
  assert.equal(progress.kind, 'query');
  assert.equal(progress.opensModelTurn, false);
  assert.equal(progress.mutated, false);
  assert.match(progress.receipt, /写到鉴权/);
  assert.deepEqual(progress.stopBotIds, []);
  assert.equal(JSON.stringify(readRoomGoals(store, roomId)), before);
  assert.deepEqual(store.writes, []);

  const who = await intakeRoomMessage(store, { roomId, text: '谁还在跑？', members });
  assert.equal(who.kind, 'query');
  assert.equal(who.opensModelTurn, false);
  assert.equal(readRoomGoals(store, roomId).goals.length, 1);
  assert.equal(readRoomGoals(store, roomId).goals[0].status, 'running');
  assert.deepEqual(store.writes, []);
});

test('a named constraint sticks, and work that could not stop is not completed under it [AC:bot-room-goal-intake#AC-2]', async () => {
  const store = memoryStore();
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到鉴权'), goal('g-doc', '写手册', '写到第二节')],
    tasks: [
      task('t-api', 'g-api', '字段迁移', 'beta', '正在改字段'),
      task('t-alpha', 'g-api', '补测试', 'alpha', '正在补测试'),
      task('t-doc', 'g-doc', '写说明', 'gamma', '写到第二节'),
    ],
    actions: [
      action('a-stuck', 'g-api', 't-api', 'beta', '已经删了一列', false),
      action('a-live', 'g-api', 't-alpha', 'alpha', '正在补测试', true),
      action('a-doc', 'g-doc', 't-doc', 'gamma', '继续写手册', true),
    ],
    stoppedBotIds: [],
  });
  store.writes.length = 0;
  const effect = await intakeRoomMessage(store, {
    roomId,
    text: '部署接口必须兼容 v1，不要删旧字段',
    members,
  });
  const saved = readRoomGoals(store, roomId);
  const api = saved.goals.find(item => item.id === 'g-api');
  const doc = saved.goals.find(item => item.id === 'g-doc');
  assert.equal(effect.kind, 'amend_goal');
  assert.equal(effect.goalId, 'g-api');
  assert.equal(effect.bumpRoomEpoch, true);
  assert.deepEqual(effect.stopBotIds, []);
  assert.deepEqual(effect.steerBotIds, ['alpha']);
  assert.equal(api.revision, 2);
  assert.equal(api.progress, '写到鉴权');
  assert.equal(api.status, 'running');
  assert.ok(api.constraints.some(item => item.includes('必须兼容 v1')));
  assert.equal(doc.revision, 1);
  assert.deepEqual(doc.constraints, []);
  assert.equal(doc.progress, '写到第二节');
  assert.equal(doc.status, 'running');
  const stuck = saved.actions.find(item => item.id === 'a-stuck');
  const live = saved.actions.find(item => item.id === 'a-live');
  assert.equal(stuck.settlement, '待核对');
  assert.notEqual(stuck.status, 'completed');
  assert.equal(live.settlement, undefined);
  assert.notEqual(live.status, 'completed');
  assert.equal(saved.tasks.find(item => item.id === 't-api').settlement, '待核对');
  assert.equal(saved.tasks.find(item => item.id === 't-doc').summary, '写到第二节');
  assert.equal(saved.tasks.find(item => item.id === 't-doc').status, 'running');
  assert.ok(!effect.steerBotIds.includes('gamma'));

  const blocked = completeRoomAction(saved, 'a-stuck');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'pending_review');
  assert.notEqual(blocked.snapshot.actions.find(item => item.id === 'a-stuck').status, 'completed');
  const taskDone = checkpointRoomTask(saved, {
    actorBotId: 'beta', hostBotId: 'alpha', taskId: 't-api', status: 'completed', summary: '按新约束完成',
  });
  assert.equal(taskDone.ok, false);
  assert.equal(taskDone.reason, 'pending_review');
  assert.notEqual(taskDone.snapshot.tasks.find(item => item.id === 't-api').status, 'completed');
});

test('naming a member stops only that member [AC:bot-room-goal-intake#AC-3]', async () => {
  const store = memoryStore();
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到鉴权'), goal('g-doc', '写手册', '写到第二节')],
    tasks: [
      task('t-beta', 'g-api', '性能压测', 'beta', '跑到第 3 轮'),
      task('t-gamma', 'g-doc', '写说明', 'gamma', '写到第二节'),
    ],
    actions: [
      action('a-beta', 'g-api', 't-beta', 'beta', '已发出的压测请求', false),
      action('a-gamma', 'g-doc', 't-gamma', 'gamma', '继续写', true),
    ],
    stoppedBotIds: [],
  });
  const effect = await intakeRoomMessage(store, { roomId, text: '取消 Beta', members });
  const saved = readRoomGoals(store, roomId);
  assert.equal(effect.kind, 'cancel');
  assert.deepEqual(effect.stopBotIds, ['beta']);
  assert.equal(effect.stopBotIds.includes('gamma'), false);
  assert.equal(effect.stopBotIds.includes('alpha'), false);
  assert.deepEqual(saved.stoppedBotIds, ['beta']);
  assert.equal(saved.tasks.find(item => item.id === 't-beta').settlement, '仍在收尾');
  assert.equal(saved.actions.find(item => item.id === 'a-beta').settlement, '仍在收尾');
  assert.equal(saved.tasks.find(item => item.id === 't-gamma').status, 'running');
  assert.equal(saved.tasks.find(item => item.id === 't-gamma').summary, '写到第二节');
  assert.equal(saved.goals.find(item => item.id === 'g-doc').status, 'running');
  assert.equal(saved.goals.find(item => item.id === 'g-doc').progress, '写到第二节');
});

test('naming one task stops only that task [AC:bot-room-goal-intake#AC-3]', async () => {
  const store = memoryStore();
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到鉴权'), goal('g-doc', '写手册', '写到第二节')],
    tasks: [
      task('t-press', 'g-api', '性能压测', 'beta', '跑到第 3 轮'),
      task('t-log', 'g-api', '补日志', 'beta', '还在补'),
      task('t-gamma', 'g-doc', '写说明', 'gamma', '写到第二节'),
    ],
    actions: [action('a-press', 'g-api', 't-press', 'beta', '已发出的压测请求', false)],
    stoppedBotIds: [],
  });
  const effect = await intakeRoomMessage(store, { roomId, text: '取消性能压测', members });
  const saved = readRoomGoals(store, roomId);
  assert.equal(effect.kind, 'cancel');
  assert.deepEqual(effect.stopTaskIds, ['t-press']);
  assert.deepEqual(effect.stopBotIds, []);
  assert.equal(saved.tasks.find(item => item.id === 't-press').settlement, '仍在收尾');
  assert.equal(saved.tasks.find(item => item.id === 't-log').status, 'running');
  assert.equal(saved.tasks.find(item => item.id === 't-log').summary, '还在补');
  assert.equal(saved.tasks.find(item => item.id === 't-gamma').status, 'running');
  assert.equal(saved.goals.find(item => item.id === 'g-doc').status, 'running');
  assert.equal(saved.goals.find(item => item.id === 'g-api').status, 'running');
});

test('an unclear change asks which item and leaves the rest running [AC:bot-room-goal-intake#AC-4]', async () => {
  const store = memoryStore();
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到鉴权'), goal('g-doc', '写手册', '写到第二节')],
    tasks: [task('t-beta', 'g-api', '性能压测', 'beta', '跑到第 3 轮')],
    actions: [],
    stoppedBotIds: [],
  });
  const before = JSON.stringify(readRoomGoals(store, roomId));
  store.writes.length = 0;
  const effect = await intakeRoomMessage(store, { roomId, text: '那个先停一下', members });
  assert.equal(effect.kind, 'clarify');
  assert.match(effect.receipt, /请说明/);
  assert.equal(effect.opensModelTurn, false);
  assert.equal(effect.mutated, false);
  assert.deepEqual(effect.stopBotIds, []);
  assert.deepEqual(effect.stopTaskIds, []);
  assert.deepEqual(effect.stopGoalIds, []);
  assert.equal(JSON.stringify(readRoomGoals(store, roomId)), before);
  assert.deepEqual(store.writes, []);
});

test('a new room goal keeps the previous room goal and the bot private goal [AC:bot-room-goal-intake#AC-5]', async () => {
  const privateGoals = { goals: [{ id: 'pg', title: '单聊目标', status: 'running', progress: '单聊做到一半' }] };
  const store = memoryStore({
    'bot_goals:alpha': privateGoals,
    bot_work_tasks: { rows: ['leave-me'] },
  });
  writeRoomGoals(store, roomId, {
    goals: [goal('g-api', '部署接口', '写到一半')],
    tasks: [],
    actions: [],
    stoppedBotIds: [],
  });
  store.writes.length = 0;
  const effect = await intakeRoomMessage(store, { roomId, text: '接下来帮我做一套监控大盘', members });
  const saved = readRoomGoals(store, roomId);
  const previous = saved.goals.find(item => item.id === 'g-api');
  assert.equal(effect.kind, 'new_goal');
  assert.equal(effect.mutated, true);
  assert.equal(saved.goals.length, 2);
  assert.equal(previous.status, 'running');
  assert.equal(previous.progress, '写到一半');
  assert.notEqual(previous.status, 'completed');
  assert.ok(saved.goals.some(item => item.id !== 'g-api' && item.title.includes('监控大盘')));
  assert.deepEqual(store.writes, ['bot.room-goals:room-1']);
  assert.deepEqual(store.getDaemonControl('bot_goals:alpha'), privateGoals);
  assert.deepEqual(store.getDaemonControl('bot_work_tasks'), { rows: ['leave-me'] });
  assert.equal(JSON.stringify(saved).includes('单聊做到一半'), false);
});

test('pausing and cancelling a whole goal retains terminal tasks and records unrecallable work', async () => {
 for (const verb of ['暂停', '取消']) {
  const store=memoryStore();
  const tasks=[task('active','g-api','执行','beta','进行中'),task('stuck','g-api','请求','beta','已发出'),task('other','g-doc','文档','gamma','进行中'),...['completed','failed','cancelled'].map(status=>({...task(status,'g-api',status,'beta','已结束'),status}))];
  writeRoomGoals(store,roomId,{goals:[goal('g-api','部署接口','进行中'),goal('g-doc','写手册','进行中')],tasks,actions:[action('a','g-api','stuck','beta','外部请求',false),action('b','g-api','active','beta','可撤回',true)],stoppedBotIds:[]});
  const effect=await intakeRoomMessage(store,{roomId,text:`${verb}部署接口`,members});
  assert.equal(effect.kind,verb==='取消'?'cancel':'pause');
  const saved=readRoomGoals(store,roomId);
  assert.equal(saved.tasks.find(t=>t.id==='active').status,verb==='取消'?'cancelled':'running');
  assert.equal(saved.tasks.find(t=>t.id==='stuck').settlement,'仍在收尾');
  assert.equal(saved.tasks.find(t=>t.id==='other').status,'running');
  for(const status of ['completed','failed','cancelled'])assert.equal(saved.tasks.find(t=>t.id===status).status,status);
 }
});

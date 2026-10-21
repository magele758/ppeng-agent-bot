import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_HUMAN_STEP_NOTICE } from '../src/rooms/human-step.ts';
import { memberMayPostWhileWaiting, viewRoomHumanStep } from '../src/rooms/approval-policy.ts';
import { readRoomGoals, roomGoalsStorageKey, writeRoomGoals } from '../src/rooms/room-goals.ts';
import {
  applyMemberHumanStep,
  assignRoomTask,
  checkpointRoomTask,
  requestNextWavePeer,
  roomTaskBoard,
} from '../src/rooms/room-tasks.ts';

const roomId = 'room-1';
const host = 'alpha';
const beta = 'beta';
const gamma = 'gamma';
const delta = 'delta';
const epsilon = 'epsilon';
const zeta = 'zeta';

function goalState(tasks = []) {
  return {
    goals: [{ id: 'g1', roomId, title: '交付', status: 'running', constraints: [], revision: 1, priority: 0, progress: '进行中', createdAt: 't0', updatedAt: 't0' }],
    tasks,
    actions: [],
    stoppedBotIds: [],
  };
}

function memoryStore() {
  const data = new Map();
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

test('the room board shows each assignee and keeps the other task when one fails [AC:bot-room-tasks#AC-1]', () => {
  const room = [host, beta, gamma];
  const first = assignRoomTask(goalState(), {
    actorBotId: host, hostBotId: host, assigneeBotId: beta, roomBotIds: room, goalId: 'g1', title: '写接口', id: 't-beta',
  });
  const second = assignRoomTask(first.snapshot, {
    actorBotId: host, hostBotId: host, assigneeBotId: gamma, roomBotIds: room, goalId: 'g1', title: '做压测', id: 't-gamma',
  });
  const running = checkpointRoomTask(second.snapshot, {
    actorBotId: beta, hostBotId: host, taskId: 't-beta', status: 'running', summary: '写到鉴权',
  });
  const failed = checkpointRoomTask(running.snapshot, {
    actorBotId: gamma, hostBotId: host, taskId: 't-gamma', status: 'failed', summary: '超时',
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.snapshot.goals[0].status, 'running');
  assert.deepEqual(roomTaskBoard(failed.snapshot).map(row => [row.title, row.assigneeBotId, row.status, row.progress]), [
    ['写接口', beta, 'running', '写到鉴权'],
    ['做压测', gamma, 'failed', '超时'],
  ]);
});

test('a peer request adds only the one valid member and does not wake the rest [AC:bot-room-tasks#AC-2]', () => {
  const roomBotIds = [host, beta, gamma, delta, epsilon, zeta];
  const roster = {
    roomBotIds,
    scheduledBotIds: [host, beta],
    spokenBotIds: [host],
    maxSpeakers: 4,
  };
  const added = requestNextWavePeer(roster, { fromBotId: beta, targetBotId: delta });
  assert.equal(added.ok, true);
  assert.equal(added.addedBotId, delta);
  assert.deepEqual(added.scheduledBotIds, [host, beta, delta]);
  assert.deepEqual(added.wokenBotIds, [delta]);
  assert.equal(added.scheduledBotIds.filter(id => id === host).length, 1);
  assert.ok(!added.scheduledBotIds.includes(epsilon));
  assert.ok(!added.scheduledBotIds.includes(zeta));
  assert.deepEqual(roster.scheduledBotIds, [host, beta]);

  const again = requestNextWavePeer(roster, { fromBotId: beta, targetBotId: host });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_spoken');
  assert.equal(again.addedBotId, undefined);
  assert.deepEqual(again.scheduledBotIds, [host, beta]);
  assert.deepEqual(again.wokenBotIds, []);

  const full = requestNextWavePeer({ ...roster, scheduledBotIds: [host, beta, gamma, delta], maxSpeakers: 4 }, { fromBotId: beta, targetBotId: epsilon });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'over_cap');
  assert.deepEqual(full.wokenBotIds, []);
  assert.notDeepEqual(full.scheduledBotIds, roomBotIds);

  const many = requestNextWavePeer(roster, { fromBotId: beta, targetBotId: delta, extraTargetBotIds: [epsilon] });
  assert.equal(many.ok, false);
  assert.equal(many.reason, 'too_many');
  assert.deepEqual(many.scheduledBotIds, [host, beta]);
  assert.deepEqual(many.wokenBotIds, []);

  const outsider = requestNextWavePeer(roster, { fromBotId: beta, targetBotId: 'not-in-room' });
  assert.equal(outsider.ok, false);
  assert.equal(outsider.reason, 'not_in_room');
  assert.deepEqual(outsider.wokenBotIds, []);
  assert.notDeepEqual(outsider.scheduledBotIds, roomBotIds);
});

test('a human step leaves the room, keeps sibling work, and lets the other members post [AC:bot-room-tasks#AC-3]', () => {
  const secret = 'tool-secret-991';
  const decision = viewRoomHumanStep({
    mode: undefined,
    botId: beta,
    requesterName: 'Beta',
    actionSummary: '登录生产环境',
    toolText: `password=${secret}`,
  });
  assert.equal(decision.mode, 'private_handoff');
  assert.equal(decision.showApprovalCard, false);
  assert.equal(decision.roomNotice, ROOM_HUMAN_STEP_NOTICE);
  assert.equal(decision.memberOutcome, 'handed_to_private_chat');
  assert.equal(decision.memberFailed, false);
  assert.equal(decision.roomWaits, false);
  assert.equal(decision.resultReturnsToRoom, false);
  assert.equal(decision.replayStepInRoom, false);
  assert.equal(decision.toolTextEntersRoomHistory, false);
  assert.equal(JSON.stringify(decision).includes(secret), false);
  assert.equal(memberMayPostWhileWaiting(beta, gamma), true);
  assert.equal(memberMayPostWhileWaiting(beta, beta), false);

  const state = goalState([
    { id: 't-alpha', goalId: 'g1', goalRevision: 1, title: '写接口', assigneeBotId: host, blockedBy: [], status: 'running', summary: '写到鉴权', materialIds: [], updatedAt: 't0' },
    { id: 't-beta', goalId: 'g1', goalRevision: 1, title: '做压测', assigneeBotId: beta, blockedBy: [], status: 'running', summary: '跑到第 3 轮', materialIds: [], updatedAt: 't0' },
  ]);
  const applied = applyMemberHumanStep(state, {
    botId: beta,
    taskId: 't-beta',
    selectedBotIds: [host, beta, gamma],
  }, decision);
  assert.equal(applied.roomWaits, false);
  assert.equal(applied.memberFailed, false);
  assert.equal(applied.memberOutcome, 'handed_to_private_chat');
  assert.deepEqual(applied.continuingBotIds, [host, gamma]);
  const mine = applied.snapshot.tasks.find(task => task.id === 't-beta');
  const sibling = applied.snapshot.tasks.find(task => task.id === 't-alpha');
  assert.notEqual(mine.status, 'failed');
  assert.equal(mine.handoff, 'private_chat');
  assert.equal(mine.summary, '跑到第 3 轮');
  assert.equal(sibling.status, 'running');
  assert.equal(sibling.summary, '写到鉴权');
  assert.equal(JSON.stringify(applied).includes(secret), false);
});

test('only the host can put a subtask on the room board [AC:bot-room-tasks#AC-4]', () => {
  const room = [host, beta];
  const denied = assignRoomTask(goalState(), {
    actorBotId: beta, hostBotId: host, assigneeBotId: gamma, roomBotIds: room, goalId: 'g1', title: '成员私自派单',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'not_host');
  assert.equal(denied.snapshot.tasks.length, 0);

  const allowed = assignRoomTask(denied.snapshot, {
    actorBotId: host, hostBotId: host, assigneeBotId: beta, roomBotIds: room, goalId: 'g1', title: '写接口', id: 't-beta',
  });
  assert.equal(allowed.ok, true);
  assert.deepEqual(roomTaskBoard(allowed.snapshot).map(row => [row.title, row.assigneeBotId, row.status]), [
    ['写接口', beta, 'queued'],
  ]);

  const store = memoryStore();
  store.setDaemonControl('bot_goals:beta', { goals: [{ id: 'private', title: '单聊目标' }] });
  store.setDaemonControl('bot_work_tasks', { rows: [1] });
  store.writes.length = 0;
  writeRoomGoals(store, roomId, allowed.snapshot);
  assert.deepEqual(store.writes, [roomGoalsStorageKey(roomId)]);
  assert.equal(roomGoalsStorageKey(roomId), 'bot.room-goals:room-1');
  assert.equal(roomTaskBoard(readRoomGoals(store, roomId))[0].title, '写接口');
  assert.deepEqual(store.getDaemonControl('bot_goals:beta'), { goals: [{ id: 'private', title: '单聊目标' }] });
  assert.deepEqual(store.getDaemonControl('bot_work_tasks'), { rows: [1] });
});

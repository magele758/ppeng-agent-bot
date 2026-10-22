import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_HUMAN_STEP_NOTICE } from '../src/rooms/human-step.ts';
import {
  memberMayPostWhileWaiting,
  resolveInlineApproval,
  resolveRoomApprovalMode,
  roomPostsAfterInlineDecision,
  viewRoomHumanStep,
} from '../src/rooms/approval-policy.ts';
import { applyMemberHumanStep } from '../src/rooms/room-tasks.ts';

const secret = 'credential-secret-772';
const toolText = `token=${secret}`;

function step(mode, extra = {}) {
  return viewRoomHumanStep({
    mode,
    botId: 'beta',
    requesterName: 'Beta',
    actionSummary: '登录生产环境',
    toolText,
    ...extra,
  });
}

test('a closed room approval policy sends the step to private chat [AC:bot-room-inline-approval#AC-1]', () => {
  for (const mode of [undefined, null, '', 'private_handoff', 'IN_ROOM', false]) {
    const decision = step(mode);
    assert.equal(resolveRoomApprovalMode(mode), 'private_handoff');
    assert.equal(decision.showApprovalCard, false);
    assert.equal(decision.card, undefined);
    assert.equal(decision.roomNotice, ROOM_HUMAN_STEP_NOTICE);
    assert.equal(decision.resultReturnsToRoom, false);
    assert.equal(decision.replayStepInRoom, false);
    assert.equal(decision.toolTextEntersRoomHistory, false);
    assert.equal(JSON.stringify(decision).includes(secret), false);
  }
});

test('an open room approval policy shows one card and does not hold the others [AC:bot-room-inline-approval#AC-2]', () => {
  const decision = step('in_room');
  assert.equal(decision.mode, 'in_room');
  assert.equal(decision.showApprovalCard, true);
  assert.equal(decision.card.botId, 'beta');
  assert.equal(decision.card.requesterName, 'Beta');
  assert.equal(decision.card.actionSummary, '登录生产环境');
  assert.equal(decision.roomWaits, false);
  assert.equal(decision.otherMembersContinue, true);
  assert.equal(decision.toolTextEntersRoomHistory, false);
  assert.equal(JSON.stringify(decision).includes(secret), false);
  assert.equal(memberMayPostWhileWaiting('beta', 'gamma'), true);
  assert.equal(memberMayPostWhileWaiting('beta', 'beta'), false);

  const applied = applyMemberHumanStep({
    goals: [{ id: 'g1', revision: 1 }],
    tasks: [
      { id: 't-alpha', goalId: 'g1', goalRevision: 1, title: '写接口', assigneeBotId: 'alpha', blockedBy: [], status: 'running', summary: '写到鉴权', materialIds: [], updatedAt: 't0' },
      { id: 't-beta', goalId: 'g1', goalRevision: 1, title: '登录', assigneeBotId: 'beta', blockedBy: [], status: 'running', summary: '等到批准', materialIds: [], updatedAt: 't0' },
    ],
  }, { botId: 'beta', taskId: 't-beta', selectedBotIds: ['alpha', 'beta', 'gamma'] }, decision);
  assert.equal(applied.roomWaits, false);
  assert.deepEqual(applied.continuingBotIds, ['alpha', 'gamma']);
  assert.equal(applied.snapshot.tasks.find(task => task.id === 't-beta').status, 'waiting_approval');
  assert.equal(applied.snapshot.tasks.find(task => task.id === 't-alpha').status, 'running');
  assert.equal(applied.snapshot.tasks.find(task => task.id === 't-alpha').summary, '写到鉴权');
  assert.equal(JSON.stringify(applied).includes(secret), false);
});

test('approving in the room continues the step and posts only the final text [AC:bot-room-inline-approval#AC-3]', () => {
  const decision = resolveInlineApproval({
    mode: 'in_room',
    decision: 'approve',
    finalText: '登录已完成',
    toolText,
    privateTranscript: 'PRIVATE_TRANSCRIPT_338',
  });
  assert.equal(decision.executed, true);
  assert.equal(decision.roomText, '登录已完成');
  assert.equal(decision.roomFailed, false);
  assert.equal(decision.otherRepliesRemain, true);
  assert.equal(decision.toolTextEntersRoomHistory, false);
  assert.equal(decision.privateTranscriptEntersRoomHistory, false);
  const posts = roomPostsAfterInlineDecision([
    { botId: 'gamma', text: '索引已经建好' },
  ], decision, 'beta');
  assert.equal(posts.some(post => post.text === '索引已经建好'), true);
  assert.equal(posts.some(post => post.text === '登录已完成'), true);
  assert.equal(JSON.stringify(posts).includes(secret), false);
  assert.equal(JSON.stringify(posts).includes('PRIVATE_TRANSCRIPT_338'), false);
});

test('rejecting in the room skips the step and keeps the other replies [AC:bot-room-inline-approval#AC-4]', () => {
  const decision = resolveInlineApproval({
    mode: 'in_room',
    decision: 'reject',
    finalText: '登录已完成',
    toolText,
    privateTranscript: 'PRIVATE_TRANSCRIPT_338',
  });
  assert.equal(decision.executed, false);
  assert.equal(decision.roomText, '已拒绝');
  assert.equal(decision.roomFailed, false);
  assert.equal(decision.otherRepliesRemain, true);
  const posts = roomPostsAfterInlineDecision([
    { botId: 'gamma', text: '索引已经建好' },
    { botId: 'alpha', text: '接口还在写' },
  ], decision, 'beta');
  assert.deepEqual(posts.map(post => post.text), ['索引已经建好', '接口还在写', '已拒绝']);
  assert.equal(JSON.stringify(posts).includes(secret), false);
  assert.equal(JSON.stringify(posts).includes('登录已完成'), false);
});

test('turning room approval back off returns the next step to private chat [AC:bot-room-inline-approval#AC-5]', () => {
  assert.equal(resolveRoomApprovalMode('in_room'), 'in_room');
  for (const mode of ['private_handoff', undefined]) {
    const decision = step(mode);
    assert.equal(decision.mode, 'private_handoff');
    assert.equal(decision.showApprovalCard, false);
    assert.equal(decision.roomNotice, ROOM_HUMAN_STEP_NOTICE);
    assert.equal(decision.resultReturnsToRoom, false);
    const settled = resolveInlineApproval({
      mode,
      decision: 'approve',
      finalText: '登录已完成',
      toolText,
      privateTranscript: 'PRIVATE_TRANSCRIPT_338',
    });
    assert.equal(settled.executed, false);
    assert.equal(settled.roomText, ROOM_HUMAN_STEP_NOTICE);
    assert.equal(settled.roomText.includes('登录已完成'), false);
    assert.equal(JSON.stringify(settled).includes(secret), false);
  }
});

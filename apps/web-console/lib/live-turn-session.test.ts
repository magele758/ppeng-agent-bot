import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedSlots } from './feed-window.ts';
import {
  detachLiveTurn,
  mayClaimSelectedSession,
  screenLiveTurn,
  shouldDetachLiveTurn,
  streamPaintApplies,
} from './live-turn-session.ts';

const historyB = [
  { id: 'b-user', role: 'user', text: 'B 的历史' },
  { id: 'b-assistant', role: 'assistant', text: 'B 的回复' },
];

test('切换会话后画面不再绘制上一场进行中的回合 [AC:bot-switch-live-turn#AC-1] [AC:bot-switch-live-turn#AC-2]', () => {
  const screen = screenLiveTurn({
    selectedSessionId: 'session-b',
    messages: historyB,
    liveSessionId: 'session-a',
    optimisticUser: 'A 正在发送',
    hasStream: true,
    waitTyping: true,
    playSending: true,
  });
  assert.equal(screen.messages, historyB);
  assert.deepEqual(
    screen.messages.map((message) => message.text),
    ['B 的历史', 'B 的回复']
  );
  assert.equal(screen.optimisticUser, null);
  assert.equal(screen.hasStream, false);
  assert.equal(screen.waitTyping, false);
  assert.equal(screen.playSending, false);

  const detached = detachLiveTurn({ generation: 4, liveSessionId: 'session-a' }, 'session-b');
  assert.equal(shouldDetachLiveTurn('session-a', 'session-b'), true);
  assert.equal(detached.detached, true);
  assert.equal(detached.liveSessionId, null);
  assert.equal(streamPaintApplies(detached.generation, 4), false);
  assert.equal(mayClaimSelectedSession(detached.generation, 4, 'session-b', 'session-a'), false);
  assert.equal(mayClaimSelectedSession(4, 4, 'session-b', 'session-a'), false);

  const slots = buildFeedSlots({
    messages: screen.messages.map((message) => ({ id: message.id })),
    turns: [],
    approvalIndexes: [],
    optimistic: Boolean(screen.optimisticUser),
    stream: screen.hasStream,
    streamApproval: false,
    typing: screen.waitTyping,
    trail: false,
  });
  assert.equal(
    slots.some((slot) => slot.kind === 'optimistic' || slot.kind === 'stream' || slot.kind === 'typing'),
    false
  );
  assert.deepEqual(
    slots.filter((slot) => slot.kind === 'message').map((slot) => slot.key),
    ['m:b-user', 'm:b-assistant']
  );
});

test('留在当前会话时继续显示这场进行中的回合 [AC:bot-switch-live-turn#AC-3]', () => {
  const historyA = [{ id: 'a-user', role: 'user', text: 'A 的问题' }];
  const screen = screenLiveTurn({
    selectedSessionId: 'session-a',
    messages: historyA,
    liveSessionId: 'session-a',
    optimisticUser: 'A 正在发送',
    hasStream: true,
    waitTyping: false,
    playSending: true,
  });
  assert.equal(screen.messages, historyA);
  assert.equal(screen.optimisticUser, 'A 正在发送');
  assert.equal(screen.hasStream, true);
  assert.equal(screen.waitTyping, false);
  assert.equal(screen.playSending, true);
  assert.equal(shouldDetachLiveTurn('session-a', 'session-a'), false);
  assert.equal(detachLiveTurn({ generation: 2, liveSessionId: 'session-a' }, 'session-a').detached, false);
  assert.equal(streamPaintApplies(2, 2), true);
  assert.equal(mayClaimSelectedSession(2, 2, 'session-a', 'session-a'), true);
  assert.equal(mayClaimSelectedSession(2, 2, null, 'session-a'), true);
});

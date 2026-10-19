import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedSlots } from './feed-window.ts';
import {
  detachLiveTurn,
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
});

test('late Bot opens cannot replace a newer request or session selection [AC:bot-switch-live-turn#AC-1]', async () => {
  const {botOpenApplies, visibleStream, liveTurnRunning} = await import('./live-turn-session.ts');
  let request = 1;
  let selected: string | null = 'a';
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const lateOpen = (async () => {
    await pending;
    if (botOpenApplies(1, request, 'a', selected, true)) selected = 'old-open-result';
  })();
  request = 2;
  selected = 'b';
  release();
  await lateOpen;
  assert.equal(selected, 'b');
  assert.equal(botOpenApplies(2, 2, 'b', 'b', true), true);
  assert.equal(botOpenApplies(2, 2, 'b', 'c', true), false);
  assert.equal(botOpenApplies(2, 2, 'b', 'b', false), false);
  assert.equal(visibleStream(false, {segments: []}), null);
  const overlay = {segments: []};
  assert.equal(visibleStream(true, overlay), overlay);
  assert.equal(liveTurnRunning('a', 'b', true, true, true), false);
  assert.equal(liveTurnRunning('a', 'a', true, false, false), true);
  assert.equal(liveTurnRunning('a', 'a', false, true, false), true);
  assert.equal(liveTurnRunning('a', 'a', false, false, true), true);
  assert.equal(liveTurnRunning('a', 'a', false, false, false), false);
});

test('returning to A does not let an old steer response clear the new composer [AC:bot-switch-live-turn#AC-1]', async () => {
  const {steerResponseApplies} = await import('./live-turn-session.ts');
  assert.equal(steerResponseApplies(1, 3, 'a', 'a'), false);
  assert.equal(steerResponseApplies(1, 1, 'a', 'b'), false);
  assert.equal(steerResponseApplies(1, 1, 'a', 'a'), true);
});

test('selection already changed before generation detaches still refuses old session adoption [AC:bot-switch-live-turn#AC-1]', async () => {
  const {mayClaimSelectedSession, canFollowSession} = await import('./live-turn-session.ts');
  assert.equal(mayClaimSelectedSession(2, 2, 'b', 'a'), false);
  assert.equal(mayClaimSelectedSession(3, 2, 'a', 'a'), false);
  assert.equal(mayClaimSelectedSession(2, 2, null, 'a'), true);
  assert.equal(mayClaimSelectedSession(2, 2, 'a', 'a'), true);
  assert.equal(canFollowSession('b', 'a'), false);
  assert.equal(canFollowSession('a', 'a'), true);
  assert.equal(canFollowSession(null, 'a'), true);
});

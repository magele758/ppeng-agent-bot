import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedSlots } from './feed-window.ts';
import {
  applyWhen,
  assertLiveTurn,
  assertSameSession,
  detachLiveTurn,
  generationForArm,
  handleSteerFailure,
  liveTurnIsRunning,
  liveTurnOwnerId,
  LiveTurnSuperseded,
  mayClaimSelectedSession,
  ownsLiveTurn,
  releaseArmOwner,
  releaseIfCurrent,
  reportOwnedError,
  restoreComposerUnlessPersisted,
  resultSessionId,
  runIf,
  screenLiveTurn,
  steerUiAfterSend,
  shouldDetachLiveTurn,
  shouldSkipForeignLiveArm,
  shouldSurfaceLiveArmError,
  shouldTickLiveArm,
  streamOverlayVisible,
  streamPaintApplies,
  streamSessionAllowed,
  tickIfPersisted,
  UNBOUND_LIVE_TURN,
  visibleLiveOverlay,
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

test('切走后、新会话装上画面前，不再绘制上一场已经写出的文字和后续吐字 [AC:bot-switch-live-turn#AC-4]', () => {
  const writtenOnA = [
    { id: 'a-user', role: 'user', text: 'A 的问题' },
    { id: 'a-assistant', role: 'assistant', text: 'A 正在吐的字' },
  ];
  const beforeBLoads = screenLiveTurn({
    selectedSessionId: 'session-b',
    loadedSessionId: 'session-a',
    messages: writtenOnA,
    liveSessionId: 'session-a',
    optimisticUser: 'A 正在发送',
    hasStream: true,
    waitTyping: true,
    playSending: true,
  });
  assert.deepEqual(beforeBLoads.messages, []);
  assert.equal(beforeBLoads.bound, false);
  assert.equal(beforeBLoads.optimisticUser, null);
  assert.equal(beforeBLoads.hasStream, false);
  assert.equal(beforeBLoads.waitTyping, false);
  assert.equal(beforeBLoads.playSending, false);

  const laterTokens = screenLiveTurn({
    selectedSessionId: 'session-b',
    loadedSessionId: 'session-a',
    messages: [...writtenOnA, { id: 'a-more', role: 'assistant', text: 'A 后续 token' }],
    liveSessionId: 'session-b',
    optimisticUser: '…',
    hasStream: true,
    waitTyping: true,
    playSending: true,
  });
  assert.deepEqual(laterTokens.messages, []);
  assert.equal(laterTokens.hasStream, false);
  assert.equal(laterTokens.waitTyping, false);
  assert.equal(laterTokens.optimisticUser, null);

  const bLoaded = screenLiveTurn({
    selectedSessionId: 'session-b',
    loadedSessionId: 'session-b',
    messages: historyB,
    liveSessionId: 'session-a',
    optimisticUser: 'A 正在发送',
    hasStream: true,
    waitTyping: true,
    playSending: true,
  });
  assert.equal(bLoaded.bound, true);
  assert.equal(bLoaded.messages, historyB);
  assert.equal(bLoaded.hasStream, false);
  assert.equal(bLoaded.optimisticUser, null);
});

test('本场直播结束后，未落库的插话仍留在当前对话流 [AC:bot-steer-visible#AC-1] [AC:bot-steer-visible#AC-2]', () => {
  const history = [{ id: 'u1', role: 'user', text: '先做这个' }];
  const screen = screenLiveTurn({
    selectedSessionId: 'session-a',
    loadedSessionId: 'session-a',
    messages: history,
    liveSessionId: null,
    optimisticUser: '先停一下',
    pendingSteerSessionId: 'session-a',
    steerLanded: false,
    hasStream: false,
    waitTyping: false,
    playSending: false,
  });
  assert.equal(screen.optimisticUser, '先停一下');
  assert.equal(screen.hasStream, false);

  const elsewhere = screenLiveTurn({
    selectedSessionId: 'session-b',
    loadedSessionId: 'session-b',
    messages: historyB,
    liveSessionId: null,
    optimisticUser: '先停一下',
    pendingSteerSessionId: 'session-a',
    steerLanded: false,
    hasStream: false,
    waitTyping: false,
    playSending: false,
  });
  assert.equal(elsewhere.optimisticUser, null);
});

test('插话写入正式消息后不再多画一条 [AC:bot-steer-visible#AC-3]', () => {
  const screen = screenLiveTurn({
    selectedSessionId: 'session-a',
    loadedSessionId: 'session-a',
    messages: [{ id: 'u2', role: 'user', text: '先停一下' }],
    liveSessionId: 'session-a',
    optimisticUser: '先停一下',
    pendingSteerSessionId: 'session-a',
    steerLanded: true,
    hasStream: true,
    waitTyping: false,
    playSending: true,
  });
  assert.equal(screen.optimisticUser, null);
  assert.equal(screen.hasStream, true);
});

test('被拒绝的插话离开对话流并回到输入框 [AC:bot-steer-visible#AC-5]', () => {
  const view = steerUiAfterSend({ rejected: true, text: '先停一下', optimistic: '先停一下' });
  assert.equal(view.bubble, null);
  assert.equal(view.composer, '先停一下');
  const kept = steerUiAfterSend({ rejected: false, text: '先停一下', optimistic: '先停一下' });
  assert.equal(kept.bubble, '先停一下');
  assert.equal(kept.composer, null);
});

test('留在当前会话时继续显示这场进行中的回合 [AC:bot-switch-live-turn#AC-3]', () => {
  const historyA = [{ id: 'a-user', role: 'user', text: 'A 的问题' }];
  const screen = screenLiveTurn({
    selectedSessionId: 'session-a',
    loadedSessionId: 'session-a',
    messages: historyA,
    liveSessionId: 'session-a',
    optimisticUser: 'A 正在发送',
    hasStream: true,
    waitTyping: false,
    playSending: true,
  });
  assert.equal(screen.bound, true);
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

test('切走后旧回合不能继续绘制、也不能把选中会话拽回去 [AC:bot-switch-live-turn#AC-1] [AC:bot-switch-live-turn#AC-2]', async () => {
  const detached = detachLiveTurn({ generation: 4, liveSessionId: 'session-a' }, 'session-b');
  assert.equal(liveTurnOwnerId(null), UNBOUND_LIVE_TURN);
  assert.equal(liveTurnOwnerId('session-a'), 'session-a');
  assert.equal(visibleLiveOverlay(false, { segments: ['old'] }), null);
  assert.deepEqual(visibleLiveOverlay(true, { segments: ['live'] }), { segments: ['live'] });

  assert.equal(
    streamOverlayVisible({
      liveGen: 4,
      activeGeneration: detached.generation,
      liveSessionId: 'session-a',
      selectedSessionId: 'session-b',
    }),
    false
  );
  assert.equal(
    streamOverlayVisible({
      liveGen: undefined,
      activeGeneration: 1,
      liveSessionId: 'session-b',
      selectedSessionId: 'session-b',
    }),
    true
  );
  assert.equal(
    streamOverlayVisible({
      liveGen: 4,
      activeGeneration: 4,
      liveSessionId: 'session-a',
      selectedSessionId: 'session-b',
    }),
    false
  );
  assert.equal(
    streamOverlayVisible({
      liveGen: 4,
      activeGeneration: 4,
      liveSessionId: 'session-a',
      selectedSessionId: 'session-a',
    }),
    true
  );
  assert.equal(resultSessionId('token', 'session-a'), null);
  assert.equal(resultSessionId('result', undefined), null);
  const sid = resultSessionId('result', 'session-a');
  assert.equal(sid, 'session-a');
  assert.equal(
    streamSessionAllowed({
      liveGen: 4,
      activeGeneration: detached.generation,
      selectedSessionId: 'session-b',
      sessionId: 'session-a',
    }),
    false
  );
  assert.equal(
    streamSessionAllowed({
      liveGen: 4,
      activeGeneration: 4,
      selectedSessionId: 'session-b',
      sessionId: 'session-a',
    }),
    false
  );
  assert.equal(
    streamSessionAllowed({
      liveGen: undefined,
      activeGeneration: 4,
      selectedSessionId: 'session-b',
      sessionId: 'session-a',
    }),
    false
  );
  assert.equal(
    streamSessionAllowed({
      liveGen: 4,
      activeGeneration: 4,
      selectedSessionId: null,
      sessionId: 'session-a',
    }),
    true
  );
  assert.equal(
    streamSessionAllowed({
      liveGen: 4,
      activeGeneration: 4,
      selectedSessionId: 'session-a',
      sessionId: 'session-a',
    }),
    true
  );

  assert.throws(() => assertLiveTurn(false), LiveTurnSuperseded);
  assert.doesNotThrow(() => assertLiveTurn(true));
  assert.throws(() => assertSameSession('session-b', 'session-a'), LiveTurnSuperseded);
  assert.doesNotThrow(() => assertSameSession('session-a', 'session-a'));

  let released = 0;
  releaseIfCurrent(false, () => released++);
  releaseIfCurrent(true, () => released++);
  assert.equal(released, 1);

  assert.equal(liveTurnIsRunning(false, true, true, true), false);
  assert.equal(liveTurnIsRunning(true, false, false, false), false);
  assert.equal(liveTurnIsRunning(true, true, false, false), true);
  assert.equal(liveTurnIsRunning(true, false, true, false), true);
  assert.equal(liveTurnIsRunning(true, false, false, true), true);

  const realError = new Error('upstream');
  assert.equal(ownsLiveTurn(new LiveTurnSuperseded(), true), false);
  assert.equal(ownsLiveTurn(realError, false), false);
  assert.equal(ownsLiveTurn(realError, true), true);
  let reports = 0;
  reportOwnedError(false, () => reports++);
  reportOwnedError(true, () => reports++);
  assert.equal(reports, 1);
  let ran = 0;
  await runIf(false, async () => ran++);
  await runIf(true, async () => ran++);
  assert.equal(ran, 1);

  let restored = 0;
  restoreComposerUnlessPersisted(true, () => restored++);
  restoreComposerUnlessPersisted(false, () => restored++);
  assert.equal(restored, 1);
  let ticks = 0;
  await tickIfPersisted(false, async () => ticks++);
  await tickIfPersisted(true, async () => ticks++);
  assert.equal(ticks, 1);

  const steer = { restored: 0, reported: 0 };
  const steerInput = {
    immediate: true,
    restore: () => steer.restored++,
    report: () => steer.reported++,
  };
  handleSteerFailure({ ...steerInput, superseded: true, sameSession: true });
  handleSteerFailure({ ...steerInput, superseded: false, sameSession: false });
  handleSteerFailure({ ...steerInput, superseded: false, sameSession: true, immediate: false });
  assert.equal(steer.restored, 0);
  assert.equal(steer.reported, 1);
  handleSteerFailure({ ...steerInput, superseded: false, sameSession: true, immediate: true });
  assert.equal(steer.restored, 1);
  assert.equal(steer.reported, 2);

  assert.equal(shouldSkipForeignLiveArm(null, 'session-a'), false);
  assert.equal(shouldSkipForeignLiveArm('session-a', 'session-a'), false);
  assert.equal(shouldSkipForeignLiveArm('session-b', 'session-a'), true);
  let claims = 0;
  assert.equal(generationForArm(true, 3, () => ++claims), 3);
  assert.equal(claims, 0);
  assert.equal(generationForArm(false, 3, () => ++claims), 1);
  assert.equal(claims, 1);
  assert.equal(shouldSurfaceLiveArmError(true, true), false);
  assert.equal(shouldSurfaceLiveArmError(false, false), false);
  assert.equal(shouldSurfaceLiveArmError(false, true), true);
  assert.equal(releaseArmOwner(false, true, true), false);
  assert.equal(releaseArmOwner(true, false, true), false);
  assert.equal(releaseArmOwner(true, true, false), false);
  assert.equal(releaseArmOwner(true, true, true), true);
  assert.equal(shouldTickLiveArm(false, false), false);
  assert.equal(shouldTickLiveArm(true, true), false);
  assert.equal(shouldTickLiveArm(true, false), true);
  let effects = 0;
  applyWhen(false, () => effects++);
  applyWhen(true, () => effects++);
  assert.equal(effects, 1);
});

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

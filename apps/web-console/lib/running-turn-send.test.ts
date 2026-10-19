import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRunningTurnSend,
  isCanonicalBotChatMetadata,
  planRunningTurnDelivery,
  shouldOpenSessionSettingsOnInboxGrowth
} from './running-turn-send.ts';

test('bot session steers immediately and a normal session asks [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-2]', () => {
  assert.equal(decideRunningTurnSend({ canonicalBotChat: true }), 'steer');
  assert.equal(decideRunningTurnSend({ canonicalBotChat: false }), 'ask');
});

test('confirming a bot interjection steers now and does not open session settings [AC:bot-immediate-steer#AC-1]', () => {
  const bot = planRunningTurnDelivery({ canonicalBotChat: true, interruptPolicy: 'queue' });
  assert.deepEqual(bot, {
    optimistic: true,
    target: 'next-step',
    revealSettings: false,
    blocked: false
  });
  assert.equal(
    shouldOpenSessionSettingsOnInboxGrowth({ previousCount: 0, nextCount: 1, immediateSteer: true }),
    false
  );
  assert.equal(
    shouldOpenSessionSettingsOnInboxGrowth({ previousCount: 1, nextCount: 1, immediateSteer: false }),
    false
  );
});

test('an ordinary running chat still queues and reveals the follow-up inbox [AC:bot-immediate-steer#AC-2]', () => {
  const queued = planRunningTurnDelivery({ canonicalBotChat: false, interruptPolicy: 'queue' });
  assert.deepEqual(queued, {
    optimistic: false,
    target: 'next-run',
    revealSettings: true,
    blocked: false
  });
  assert.equal(
    shouldOpenSessionSettingsOnInboxGrowth({ previousCount: 0, nextCount: 1, immediateSteer: false }),
    true
  );
  const steered = planRunningTurnDelivery({ canonicalBotChat: false, interruptPolicy: 'steer' });
  assert.equal(steered.target, 'next-step');
  assert.equal(steered.optimistic, false);
  assert.equal(steered.revealSettings, true);
  const blocked = planRunningTurnDelivery({ canonicalBotChat: false, interruptPolicy: 'disabled' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.revealSettings, false);
});

test('only a canonical bot chat is immediate; subagent and plain chats still ask [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-2]', () => {
  assert.equal(
    isCanonicalBotChatMetadata({ mode: 'chat', metadata: { canonicalBotChat: true } }),
    true
  );
  assert.equal(isCanonicalBotChatMetadata({ mode: 'chat', metadata: {} }), false);
  assert.equal(
    isCanonicalBotChatMetadata({ mode: 'subagent', metadata: { canonicalBotChat: true } }),
    false
  );
  assert.equal(
    isCanonicalBotChatMetadata({ mode: 'task', metadata: { canonicalBotChat: true } }),
    false
  );
  assert.equal(
    decideRunningTurnSend({
      canonicalBotChat: isCanonicalBotChatMetadata({ mode: 'chat', metadata: { canonicalBotChat: true } })
    }),
    'steer'
  );
  assert.equal(
    decideRunningTurnSend({
      canonicalBotChat: isCanonicalBotChatMetadata({ mode: 'chat', metadata: {} })
    }),
    'ask'
  );
});

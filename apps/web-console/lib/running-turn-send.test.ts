import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRunningTurnSend, isCanonicalBotChatMetadata } from './running-turn-send.ts';

test('bot session steers immediately and a normal session asks [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-2]', () => {
  assert.equal(decideRunningTurnSend({ canonicalBotChat: true }), 'steer');
  assert.equal(decideRunningTurnSend({ canonicalBotChat: false }), 'ask');
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

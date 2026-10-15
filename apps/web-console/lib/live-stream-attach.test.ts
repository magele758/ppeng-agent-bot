import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachBeforeAskUserDecision,
  liveSessionFollowRequest,
  shouldAttachLiveStreamAfterAskUser
} from './live-stream-attach.ts';

test('回复并继续后重新接上实时输出 [AC:ask-user-live-stream#AC-1]', async () => {
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'ask_user', decision: 'approve', otherPendingCount: 0 }),
    true
  );
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'ask_user', decision: 'approve', otherPendingCount: 2 }),
    true
  );
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'bash', decision: 'approve', otherPendingCount: 0 }),
    false
  );
  const req = liveSessionFollowRequest('sess/1');
  assert.equal(req.url, '/api/sessions/sess%2F1/stream');
  assert.deepEqual(req.body, { follow: true });

  const order: string[] = [];
  let cancelled = false;
  const outcome = await attachBeforeAskUserDecision({
    toolName: 'ask_user',
    decision: 'approve',
    otherPendingCount: 0,
    sessionId: 'sess/1',
    arm: () => {
      order.push('arm');
      return {
        ready: Promise.resolve().then(() => {
          order.push('ready');
        }),
        cancel: () => {
          cancelled = true;
        }
      };
    },
    postDecision: async () => {
      order.push('decide');
    }
  });
  assert.equal(outcome, 'attached');
  assert.deepEqual(order, ['arm', 'ready', 'decide']);
  assert.equal(cancelled, false);

  await assert.rejects(
    attachBeforeAskUserDecision({
      toolName: 'ask_user',
      decision: 'approve',
      otherPendingCount: 0,
      sessionId: 'sess/1',
      arm: () => ({
        ready: Promise.resolve(),
        cancel: () => {
          cancelled = true;
        }
      }),
      postDecision: async () => {
        throw new Error('approve failed');
      }
    })
  );
  assert.equal(cancelled, true);
});

test('拒绝追问且没有其他待审批时重新接上实时输出 [AC:ask-user-live-stream#AC-2]', async () => {
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'ask_user', decision: 'reject', otherPendingCount: 0 }),
    true
  );
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'ask_user', decision: 'reject', otherPendingCount: 1 }),
    false
  );
  assert.equal(
    shouldAttachLiveStreamAfterAskUser({ toolName: 'bash', decision: 'reject', otherPendingCount: 0 }),
    false
  );

  let armed = false;
  const skipped = await attachBeforeAskUserDecision({
    toolName: 'ask_user',
    decision: 'reject',
    otherPendingCount: 1,
    sessionId: 'sess',
    arm: () => {
      armed = true;
      return { ready: Promise.resolve(), cancel: () => undefined };
    },
    postDecision: async () => undefined
  });
  assert.equal(skipped, 'skipped');
  assert.equal(armed, false);

  const attached = await attachBeforeAskUserDecision({
    toolName: 'ask_user',
    decision: 'reject',
    otherPendingCount: 0,
    sessionId: 'sess',
    arm: () => {
      armed = true;
      return { ready: Promise.resolve(), cancel: () => undefined };
    },
    postDecision: async () => undefined
  });
  assert.equal(attached, 'attached');
  assert.equal(armed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalApproveDisabled,
  approvalDecisionFlow,
  approvalItemBodyKind,
  approvalPostPlan,
  approvalSendAskReply,
  approvalUsesStreamAttach
} from './approval-item-view.ts';

test('approvalItemBodyKind prefers secure form then ask/preview', () => {
  assert.equal(approvalItemBodyKind({ hasSecureForm: true, isAsk: true, hasQuestion: true }), 'secure-form');
  assert.equal(approvalItemBodyKind({ hasSecureForm: false, isAsk: false, hasQuestion: false }), 'preview');
  assert.equal(approvalItemBodyKind({ hasSecureForm: false, isAsk: true, hasQuestion: true }), 'ask');
  assert.equal(approvalItemBodyKind({ hasSecureForm: false, isAsk: true, hasQuestion: false }), 'empty');
});

test('approvalApproveDisabled only blocks empty ask replies', () => {
  assert.equal(approvalApproveDisabled(true, ''), true);
  assert.equal(approvalApproveDisabled(true, '  '), true);
  assert.equal(approvalApproveDisabled(true, 'yes'), false);
  assert.equal(approvalApproveDisabled(false, ''), false);
});

test('approvalPostPlan covers ask-reply and noop paths', () => {
  assert.deepEqual(
    approvalPostPlan({ decision: 'reject', isAsk: true, reply: 'x', hasSession: true }),
    { type: 'decision-only' }
  );
  assert.deepEqual(
    approvalPostPlan({ decision: 'approve', isAsk: false, reply: 'x', hasSession: true }),
    { type: 'decision-only' }
  );
  assert.deepEqual(
    approvalPostPlan({ decision: 'approve', isAsk: true, reply: '  ', hasSession: true }),
    { type: 'noop' }
  );
  assert.deepEqual(
    approvalPostPlan({ decision: 'approve', isAsk: true, reply: 'hi', hasSession: false }),
    { type: 'noop' }
  );
  assert.deepEqual(
    approvalPostPlan({ decision: 'approve', isAsk: true, reply: '  hi  ', hasSession: true }),
    { type: 'ask-reply', reply: 'hi' }
  );
});

test('approvalUsesStreamAttach', () => {
  assert.equal(approvalUsesStreamAttach({ hasAttachStream: false }), 'direct');
  assert.equal(approvalUsesStreamAttach({ hasAttachStream: true }), 'attach');
});

test('approvalDecisionFlow stops on noop and otherwise follows the stream flag', () => {
  assert.equal(approvalDecisionFlow({ plan: { type: 'noop' }, hasAttachStream: true }), 'stop');
  assert.equal(approvalDecisionFlow({ plan: { type: 'decision-only' }, hasAttachStream: false }), 'direct');
  assert.equal(
    approvalDecisionFlow({ plan: { type: 'ask-reply', reply: 'hi' }, hasAttachStream: true }),
    'attach'
  );
});

test('approvalSendAskReply posts only an ask-reply with a session', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const post = async (path: string, body: unknown) => {
    calls.push({ path, body });
  };
  await approvalSendAskReply({ plan: { type: 'decision-only' }, sessionId: 's1', post });
  await approvalSendAskReply({ plan: { type: 'ask-reply', reply: 'hi' }, sessionId: undefined, post });
  await approvalSendAskReply({ plan: { type: 'ask-reply', reply: 'hi' }, sessionId: 's/1', post });
  assert.deepEqual(calls, [{ path: '/api/sessions/s%2F1/ask-user/reply', body: { reply: 'hi' } }]);
});

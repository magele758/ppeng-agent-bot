import test from 'node:test';
import assert from 'node:assert/strict';
import {
  egressNeedsApproval,
  isMcpMutationTool,
  isMcpReadOnlyTool,
  modelTriedToSelfApprove,
  requireHumanEgressApproval,
  stripModelSelfApproval
} from '../dist/safety/egress.js';

test('egress approval is required for social posts and not for the mailbox', () => {
  assert.equal(egressNeedsApproval('schedule_social_post', { approval: 'approved' }), true);
  assert.equal(egressNeedsApproval('send_message', { text: 'hi' }), false);
  assert.equal(egressNeedsApproval('web_fetch', {}), false);
});

test('MCP reads stay reads and only named writes are mutations', () => {
  assert.equal(isMcpReadOnlyTool('whoami'), true);
  assert.equal(isMcpReadOnlyTool('say', true), true);
  assert.equal(isMcpMutationTool('say'), true);
  assert.equal(isMcpMutationTool('say', true), false);
  assert.equal(isMcpMutationTool('whoami'), false);
  assert.equal(isMcpMutationTool('custom_unknown'), false);
});

test('model self-approval is visible and stripped only from the copy', () => {
  const args = { text: 'hi', approval: 'approved', approved: true, keep: 1 };
  assert.equal(modelTriedToSelfApprove(args), true);
  const stripped = stripModelSelfApproval(args);
  assert.deepEqual(stripped, { text: 'hi', keep: 1 });
  assert.equal(args.approval, 'approved');
  assert.deepEqual(stripModelSelfApproval({ approval: 'pending_approval', approved: false }), {
    approval: 'pending_approval',
    approved: false
  });
  assert.throws(() => requireHumanEgressApproval(undefined), /egress_not_approved/);
  assert.throws(() => requireHumanEgressApproval('pending_approval'), /egress_not_approved/);
  assert.doesNotThrow(() => requireHumanEgressApproval('approved'));
});

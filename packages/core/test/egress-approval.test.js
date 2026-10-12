import test from 'node:test';
import assert from 'node:assert/strict';
import {
  egressNeedsApproval,
  isMcpMutationTool,
  isMcpReadOnlyTool,
  modelTriedToSelfApprove,
  mcpCallArgs,
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

test('MCP calls drop self-approval even when the server marks the tool read-only', () => {
  const readOnly = mcpCallArgs({ approval: 'approved', approved: true, q: 'hi' });
  assert.deepEqual(readOnly, { q: 'hi' });
  const unknown = mcpCallArgs({ approval: 'approved', approved: true, keep: 1 });
  assert.deepEqual(unknown, { keep: 1 });
  assert.deepEqual(mcpCallArgs({ approval: 'pending_approval' }), { approval: 'pending_approval' });
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

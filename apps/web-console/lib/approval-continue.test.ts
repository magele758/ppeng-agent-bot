import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isApprovalContinueMessage } from './approval-continue.ts';

test('[AC:hide-approval-continue#AC-1] hides synthetic approval continuation', () => {
  assert.equal(isApprovalContinueMessage('user', 'Approval for bash was approved. Continue.'), true);
  assert.equal(isApprovalContinueMessage('user', 'Approval for bash was rejected. Continue.'), true);
  assert.equal(isApprovalContinueMessage('user', 'Approval for bash was denied. Continue.'), true);
});

test('[AC:hide-approval-continue#AC-2] keeps real input', () => {
  assert.equal(isApprovalContinueMessage('user', 'please note Approval for bash was approved. Continue.'), false);
  assert.equal(isApprovalContinueMessage('user', 'Approval for bash was approved. Continue. thanks'), false);
  assert.equal(isApprovalContinueMessage('assistant', 'Approval for bash was approved. Continue.'), false);
});

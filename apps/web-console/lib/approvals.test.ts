import assert from 'node:assert/strict';
import test from 'node:test';
import { isPendingApproval, pendingApprovals } from './approvals.ts';

test('已处理（批准/拒绝/过期）的审批不计入待审批 [AC:console-tasks#AC-4]', () => {
  const items = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'rejected' },
    { id: 'c', status: 'approved' },
    { id: 'd', status: 'expired' },
    { id: 'e' }
  ];
  assert.deepEqual(
    pendingApprovals(items).map((x) => x.id),
    ['a', 'e']
  );
});

test('没有任何待审批项时结果为空，徽标数量为 0 [AC:console-tasks#AC-5]', () => {
  assert.equal(pendingApprovals([{ status: 'rejected' }]).length, 0);
  assert.equal(pendingApprovals(undefined).length, 0);
  assert.equal(isPendingApproval({ status: 'expired' }), false);
});

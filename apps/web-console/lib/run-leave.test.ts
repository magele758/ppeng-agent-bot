import assert from 'node:assert/strict';
import test from 'node:test';
import { leaveCancelsRun, shouldResumeRunningTurn } from './run-leave.ts';

test('刷新、卸载和离开不取消回合，点停止才会 [AC:refresh-keeps-agent-run#AC-1] [AC:refresh-keeps-agent-run#AC-2] [AC:chat-basics#AC-5]', () => {
  assert.equal(leaveCancelsRun('refresh'), false);
  assert.equal(leaveCancelsRun('unmount'), false);
  assert.equal(leaveCancelsRun('navigate'), false);
  assert.equal(leaveCancelsRun('stop'), true);
});

test('重新打开仍在跑的会话时接上这场回合 [AC:refresh-keeps-agent-run#AC-3]', () => {
  assert.equal(shouldResumeRunningTurn({ status: 'running', locallySending: false }), true);
  assert.equal(shouldResumeRunningTurn({ status: 'running', locallySending: true }), false);
  assert.equal(shouldResumeRunningTurn({ status: 'idle', locallySending: false }), false);
  assert.equal(shouldResumeRunningTurn({ status: 'failed', locallySending: false }), false);
  assert.equal(shouldResumeRunningTurn({ status: undefined, locallySending: false }), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { leaveCancelsRun, shouldRefreshOpenSession, shouldResumeRunningTurn } from './run-leave.ts';

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

test('另一个网页看到这场对话仍在跑时也接上流式结果 [AC:multi-page-live-session#AC-1]', () => {
  assert.equal(shouldResumeRunningTurn({ status: 'idle', locallySending: false, sharedStatus: 'running' }), true);
  assert.equal(shouldResumeRunningTurn({ status: undefined, locallySending: false, sharedStatus: 'running' }), true);
  assert.equal(shouldResumeRunningTurn({ status: 'idle', locallySending: true, sharedStatus: 'running' }), false);
  assert.equal(shouldResumeRunningTurn({ status: 'idle', locallySending: false, sharedStatus: 'idle' }), false);
});

test('正在生成时，其他打开的网页继续刷新页面状态 [AC:multi-page-live-session#AC-3]', () => {
  assert.equal(shouldRefreshOpenSession({ openSessionId: 's1', selectedSessionId: 's1', selectedStatus: 'running' }), true);
  assert.equal(shouldRefreshOpenSession({ openSessionId: 's1', selectedSessionId: 's2', selectedStatus: 'running' }), false);
  assert.equal(shouldRefreshOpenSession({ openSessionId: 's1', selectedSessionId: 's1', selectedStatus: 'idle' }), false);
  assert.equal(shouldRefreshOpenSession({ openSessionId: null, selectedSessionId: 's1', selectedStatus: 'running' }), false);
});

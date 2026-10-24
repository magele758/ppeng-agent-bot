import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalsForChat } from './goal-chat-approvals.ts';

test('主对话能看到子任务停住的待批准 [AC:bot-goal-nested-approval#AC-1]', () => {
  const sessions = [
    { id: 'chat' },
    { id: 'child', parentSessionId: 'chat' },
    { id: 'grandchild', metadata: { parentSessionId: 'child' } },
    { id: 'other', parentSessionId: 'elsewhere' }
  ];
  const approvals = [
    { id: 'own', toolName: 'ask_user', sessionId: 'chat', status: 'pending' as const, reason: 'ask', args: {}, createdAt: '' },
    { id: 'nested', toolName: 'bash', sessionId: 'grandchild', status: 'pending' as const, reason: 'rm', args: { command: 'rm -rf wrong-path' }, createdAt: '' },
    { id: 'foreign', toolName: 'bash', sessionId: 'other', status: 'pending' as const, reason: 'other', args: {}, createdAt: '' },
    { id: 'done', toolName: 'bash', sessionId: 'child', status: 'approved' as const, reason: 'done', args: {}, createdAt: '' }
  ];
  const visible = approvalsForChat('chat', approvals, sessions);
  assert.deepEqual(visible.map(item => item.id), ['own', 'nested']);
});

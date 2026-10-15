import assert from 'node:assert/strict';
import test from 'node:test';
import { anchorApprovals, approvalShownLines, type FeedMessageLike } from './approval-feed.ts';

const REASON = 'Approval required for ask_user (permissionMode=auto)';

const messages: FeedMessageLike[] = [
  { parts: [{ type: 'text', text: 'hi' }] },
  {
    parts: [
      { type: 'tool_call', toolCallId: 'old', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', toolCallId: 'old', name: 'bash' }
    ]
  },
  {
    parts: [{ type: 'tool_call', toolCallId: 'ask-1', name: 'ask_user', input: { question: '选哪个？' } }]
  }
];

test('待审批紧挨着正在等待的工具调用 [AC:chat-approval-inline#AC-1]', () => {
  const approval = { id: 'a1', toolName: 'ask_user', reason: REASON, args: { question: '选哪个？' } };
  const anchored = anchorApprovals(messages, [approval], new Set(['old']));
  assert.deepEqual(anchored.afterMessage.get(2)?.map((item) => item.id), ['a1']);
  assert.equal(anchored.afterMessage.has(0), false);
  assert.equal(anchored.afterMessage.has(1), false);
  assert.deepEqual(anchored.afterStream, []);
  assert.deepEqual(anchored.trailing, []);

  const live = anchorApprovals([], [approval], new Set(), [
    { name: 'ask_user', toolCallId: 'ask-1', args: JSON.stringify({ question: '选哪个？' }) }
  ]);
  assert.equal(live.afterMessage.size, 0);
  assert.deepEqual(live.afterStream.map((item) => item.id), ['a1']);

  const finished = anchorApprovals(messages, [approval], new Set(['old', 'ask-1']));
  assert.equal(finished.afterMessage.size, 0);
  assert.deepEqual(finished.trailing.map((item) => item.id), ['a1']);
});

test('同一句英文原因只出现一次 [AC:chat-approval-inline#AC-2]', () => {
  const missingQuestion = approvalShownLines(
    { toolName: 'ask_user', reason: REASON, args: {} },
    '需要你补充信息'
  );
  const visible = [missingQuestion.reason, missingQuestion.question].filter(Boolean);
  assert.deepEqual(visible, [REASON]);

  const repeated = approvalShownLines(
    { toolName: 'ask_user', reason: REASON, args: { question: REASON } },
    '需要你补充信息'
  );
  assert.equal(repeated.reason, REASON);
  assert.equal(repeated.question, null);

  const distinct = approvalShownLines(
    { toolName: 'ask_user', reason: REASON, args: { question: '选哪个？' } },
    '需要你补充信息'
  );
  assert.equal(distinct.reason, REASON);
  assert.equal(distinct.question, '选哪个？');
});

test('提问仍可回复，其他工具仍可批准或拒绝 [AC:chat-approval-inline#AC-3]', () => {
  const ask = approvalShownLines({ toolName: 'ask_user', reason: REASON, args: { question: '选哪个？' } }, '需要你补充信息');
  const bash = approvalShownLines(
    { toolName: 'bash', reason: 'Approval required for bash (permissionMode=auto)', args: { command: 'ls' } },
    '需要你补充信息'
  );
  assert.equal(ask.reply, true);
  assert.equal(bash.reply, false);
  assert.equal(bash.question, null);
  assert.equal(bash.reason, 'Approval required for bash (permissionMode=auto)');
});

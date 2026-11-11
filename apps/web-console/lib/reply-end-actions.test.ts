import test from 'node:test';
import assert from 'node:assert/strict';
import { groupReplySlots } from './reply-hover-run.ts';
import { assistantActionsHeld, liveReplyHoldIndex, replyActionsHeld } from './reply-end-actions.ts';
import type { FeedSlot } from './feed-window.ts';
import type { ChatMessage } from './types.ts';

function slot(index: number): FeedSlot {
  return { key: String(index), kind: 'message', messageIndex: index };
}

function message(role: string, text: string, createdAt?: string): ChatMessage {
  return { id: text, role, createdAt, parts: [{ type: 'text', text }] } as ChatMessage;
}

test('多段回复只在最后一段挂一组操作 [AC:turn-end-actions#AC-1] [AC:whole-reply-hover#AC-1]', () => {
  const messages = [
    message('user', '问'),
    message('assistant', '已读取配置。'),
    message('tool', '工具记录'),
    message('assistant', '检查完成。', '2026-11-10T07:50:00Z'),
    message('user', '下一题'),
    message('assistant', '另一条回复。')
  ];
  const grouped = groupReplySlots(messages.map((_, index) => slot(index)), messages, false);
  const run = grouped.find((item) => item.replyRun);
  assert.equal(run?.replyRun?.end, 3);
  assert.equal(run?.replyRun?.first, 1);
  assert.equal(run?.replyRun?.text, '已读取配置。\n\n检查完成。');
  assert.equal(run?.replyRun?.last.createdAt, '2026-11-10T07:50:00Z');
  assert.equal(grouped.filter((item) => item.replyRun).length, 1);
});

test('还在输出的这一轮不显示末尾操作 [AC:turn-end-actions#AC-2]', () => {
  const messages = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' }
  ];
  assert.equal(liveReplyHoldIndex(messages, {}), null);
  assert.equal(liveReplyHoldIndex(messages, { optimisticUser: '新问题', streamOverlay: {} }), null);
  assert.equal(liveReplyHoldIndex(messages, { streamOverlay: {} }), 2);
  assert.equal(liveReplyHoldIndex(messages, { waitTyping: true }), 2);
  assert.equal(liveReplyHoldIndex(messages, { heldAssistantText: '还没落成' }), 2);
  assert.equal(liveReplyHoldIndex([], { streamOverlay: {} }), 0);
  assert.equal(replyActionsHeld(2, 1), false);
  assert.equal(replyActionsHeld(2, 3), true);
  assert.equal(replyActionsHeld(null, 3), false);
  assert.equal(assistantActionsHeld('user', 2, 2), false);
  assert.equal(assistantActionsHeld('tool', 2, 3), false);
  assert.equal(assistantActionsHeld('assistant', 2, 2), true);
  assert.equal(assistantActionsHeld('assistant', 2, 1), false);
});

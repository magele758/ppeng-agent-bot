import test from 'node:test';
import assert from 'node:assert/strict';
import { continuedAssistantIndexes } from './assistant-label-run.ts';
import type { FeedSlot } from './feed-window.ts';

const msg = (i: number): FeedSlot => ({ key: `m${i}`, kind: 'message', messageIndex: i });
const roles = ['user', 'assistant', 'system', 'assistant', 'assistant', 'user', 'assistant'];
const roleOf = (i: number) => roles[i];

test('折叠块与系统消息隔开的助手消息只保留第一条标题 [AC:assistant-label-dedupe#AC-1]', () => {
  const slots: FeedSlot[] = [
    msg(0),
    msg(1),
    { key: 'n', kind: 'brief-note', briefCount: 2, folded: [msg(2), msg(3)] },
    msg(4)
  ];
  assert.deepEqual([...continuedAssistantIndexes(slots, roleOf)], [3, 4]);
});

test('用户消息之后助手标题重新出现 [AC:assistant-label-dedupe#AC-2]', () => {
  const slots = [0, 1, 3, 5, 6].map(msg);
  assert.deepEqual([...continuedAssistantIndexes(slots, roleOf)], [3]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBotRelayMessage } from './bot-relay-message.ts';

const TASK = 'Message from 科研小助手 / bot_367eca0123abcd: Delegated task btask_9f8e7d: 请评估这篇论文的实验设计\n\n1. 数据集\n2. 基线\nReport the concrete result; this execution is tracked automatically.';

test('[AC:bot-relay-strip#AC-1] parses delegated task, result and plain bot message', () => {
  const task = parseBotRelayMessage('user', TASK);
  assert.deepEqual(
    task && { name: task.senderName, kind: task.kind, summary: task.summary },
    { name: '科研小助手', kind: 'task', summary: '请评估这篇论文的实验设计' }
  );
  const result = parseBotRelayMessage('user', 'Message from 写作助手 / bot_ab12 (from room room_1): Task btask_77 failed: 超时未完成\n细节');
  assert.equal(result?.kind, 'result');
  assert.equal(result?.status, 'failed');
  assert.equal(result?.summary, '超时未完成');
  const plain = parseBotRelayMessage('user', 'Message from 小助手 / bot_c3: 你好，\n第二行');
  assert.equal(plain?.kind, 'message');
  assert.equal(plain?.summary, '你好，');
  const long = parseBotRelayMessage('user', `Message from A / bot_1: ${'字'.repeat(200)}`);
  assert.ok(long && long.summary.length <= 81 && long.summary.endsWith('…'));
  for (const parsed of [task, result, plain]) assert.doesNotMatch(parsed!.summary, /bot_|btask_/);
});

test('[AC:bot-relay-strip#AC-2] ignores ordinary input and lookalikes', () => {
  assert.equal(parseBotRelayMessage('user', '请帮我看看这个'), null);
  assert.equal(parseBotRelayMessage('user', `我收到一条：${TASK}`), null);
  assert.equal(parseBotRelayMessage('assistant', TASK), null);
  assert.equal(parseBotRelayMessage('user', 'Message from 科研小助手: Delegated task btask_1: 你好'), null);
  assert.equal(parseBotRelayMessage('user', 'Message from 科研小助手 / user_1: 你好'), null);
});

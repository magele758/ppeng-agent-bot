import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_BAND_ORDER,
  buildBotNameMap,
  classifyQueueBand,
  extractJobDisplayTitle,
  formatQueueEventSummary,
  getScheduleActions,
  groupQueueTasks,
  matchesQueueQuery,
  resolveAgentLabel,
} from './task-queue-view.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');

test('classifyQueueBand and groupQueueTasks order failed and active work ahead of completed [AC:bot-tasks-queue-redesign#AC-5]', () => {
  assert.deepEqual(QUEUE_BAND_ORDER, ['attention', 'active', 'pending', 'done']);
  assert.equal(classifyQueueBand('failed'), 'attention');
  assert.equal(classifyQueueBand('in_progress'), 'active');
  assert.equal(classifyQueueBand('pending'), 'pending');
  assert.equal(classifyQueueBand('completed'), 'done');
  assert.equal(classifyQueueBand('cancelled'), 'done');

  const tasks = [
    { id: '1', title: 'Done work', status: 'completed' },
    { id: '2', title: 'Broken deploy', status: 'failed' },
    { id: '3', title: 'Waiting', status: 'pending' },
    { id: '4', title: 'Running build', status: 'in_progress' },
    { id: '5', title: 'Dropped', status: 'cancelled' },
  ];
  const grouped = groupQueueTasks(tasks);
  assert.deepEqual(grouped.attention.map((t) => t.id), ['2']);
  assert.deepEqual(grouped.active.map((t) => t.id), ['4']);
  assert.deepEqual(grouped.pending.map((t) => t.id), ['3']);
  assert.deepEqual(grouped.done.map((t) => t.id), ['1', '5']);
});

test('resolveAgentLabel maps opaque Bot IDs to readable Bot names and matches search by resolved name [AC:bot-tasks-queue-redesign#AC-6]', () => {
  const bots = [
    { id: 'bot_78bcb2c239c14f50a31f959e6eea8cff', name: '发布管家' },
    { id: 'bot_plain', name: '   ' },
  ];
  const map = buildBotNameMap(bots);

  assert.equal(resolveAgentLabel('bot_78bcb2c239c14f50a31f959e6eea8cff', bots, '未分配'), '发布管家');
  assert.equal(resolveAgentLabel('coder', bots, '未分配'), 'coder');
  assert.equal(resolveAgentLabel('bot_plain', bots, '未分配'), 'bot_plain');
  assert.equal(resolveAgentLabel(undefined, bots, '未分配'), '未分配');

  const task = {
    title: '准备发布说明',
    description: '核对 changelog 与风险项',
    ownerAgentId: 'bot_78bcb2c239c14f50a31f959e6eea8cff',
  };
  assert.equal(matchesQueueQuery(task, '发布管家', map), true);
  assert.equal(matchesQueueQuery(task, 'bot_78bcb2', map), true);
  assert.equal(matchesQueueQuery(task, 'CHANGELOG', map), true);
  assert.equal(matchesQueueQuery(task, 'zzz-none', map), false);
});

test('extractJobDisplayTitle distills verbose shell pipelines and preserves fallback [AC:bot-tasks-queue-redesign#AC-6]', () => {
  const cmd =
    'cd /Users/penglei/developer/self-test-grounding/ppeng-agent-core && grok --prompt-file /tmp/prompts/review-task.md --model fast > /tmp/grok.log 2>&1';
  assert.equal(extractJobDisplayTitle(cmd, '（未命名任务）'), 'grok --prompt-file …/review-task.md --model fast');

  const simple = extractJobDisplayTitle('pnpm run test:unit', '（未命名任务）');
  assert.equal(simple, 'pnpm run test:unit');

  const empty = extractJobDisplayTitle('   ', '（未命名任务）');
  assert.equal(empty, '（未命名任务）');

  const onlyCd = extractJobDisplayTitle('cd /tmp/work', '（未命名任务）');
  assert.equal(onlyCd, 'cd /tmp/work');
});

test('formatQueueEventSummary and getScheduleActions support queue detail timeline and schedule actions [AC:bot-tasks-queue-redesign#AC-7]', () => {
  const ev = {
    id: 'ev1',
    taskId: 't1',
    kind: 'task.failed',
    actor: 'coder',
    payload: { reason: 'Exit code 1' },
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
  };
  const zh = formatQueueEventSummary(ev, 'zh', NOW);
  assert.equal(zh.title, '执行失败');
  assert.equal(zh.detail, 'coder · Exit code 1');
  assert.equal(zh.time, '5 分钟前');

  const en = formatQueueEventSummary({ ...ev, kind: 'custom.event', payload: {} }, 'en', NOW);
  assert.equal(en.title, 'custom.event');
  assert.equal(en.detail, 'coder');
  assert.equal(en.time, '5m ago');

  assert.deepEqual(getScheduleActions('pending'), ['approve', 'reject', 'run_now', 'cancel']);
  assert.deepEqual(getScheduleActions('in_progress'), ['cancel']);
  assert.deepEqual(getScheduleActions('failed'), ['run_now', 'cancel']);
  assert.deepEqual(getScheduleActions('completed'), []);
  assert.deepEqual(getScheduleActions('cancelled'), []);
});

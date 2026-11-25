import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_BAND_ORDER,
  QUEUE_EVENT_KEY_MAP,
  buildBotNameMap,
  classifyQueueBand,
  extractJobDisplayTitle,
  extractQueueTaskPreview,
  formatQueueEventSummary,
  getScheduleActions,
  groupQueueTasks,
  matchesQueueQuery,
  queueEventTitleKey,
  resolveAgentLabel,
} from './task-queue-view.ts';
import { relativeTimeLabelsFrom } from './bot-tasks-view.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { en } from './i18n/messages/en/index.ts';

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

  const sshCmd =
    "ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 ubuntu1 'while ps -p 1234 >/dev/null; do sleep 5; done'";
  assert.equal(extractJobDisplayTitle(sshCmd, '（未命名任务）'), 'ssh ubuntu1 · while ps -p 1234');

  const sshChained =
    "cd /Users/penglei/project && ssh -i ~/.ssh/id_ed25519 -p 2222 -q ubuntu2 'cd /opt/srv && pnpm run test > /tmp/out.log 2>&1'";
  assert.equal(extractJobDisplayTitle(sshChained, '（未命名任务）'), 'ssh ubuntu2 · pnpm run test');

  assert.equal(
    extractQueueTaskPreview('Self-heal repair Policy: {"testPreset":"unit","maxRetries":2}'),
    'Self-heal repair'
  );
  assert.equal(
    extractQueueTaskPreview('Policy: {"testPreset":"unit"}\n修复核心单元测试回归'),
    '修复核心单元测试回归'
  );
  assert.equal(extractQueueTaskPreview('Policy: {"testPreset":"unit"}'), '');
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
  assert.equal(queueEventTitleKey('task.failed'), 'tasks.queue.eventTypes.taskFailed');
  assert.equal(Object.keys(QUEUE_EVENT_KEY_MAP).length, 7);

  const zhEventMap = zh.tasks.queue.eventTypes as Record<string, string>;
  const zhLabels = relativeTimeLabelsFrom((key, vars) => {
    const map: Record<string, string> = {
      'botWork.timeJustNow': zh.botWork.timeJustNow,
      'botWork.timeMinutesAgo': zh.botWork.timeMinutesAgo,
      'botWork.timeHoursAgo': zh.botWork.timeHoursAgo,
      'botWork.timeDaysAgo': zh.botWork.timeDaysAgo,
    };
    return map[key].replace('{count}', String(vars?.count ?? ''));
  });
  const zhSummary = formatQueueEventSummary(ev, 'zh', {
    nowMs: NOW,
    resolveTitle: (kind, key) => (key ? zhEventMap[key.split('.').pop()!] : kind),
    relativeLabels: zhLabels,
  });
  assert.equal(zhSummary.title, '执行失败');
  assert.equal(zhSummary.detail, 'coder · Exit code 1');
  assert.equal(zhSummary.time, '5 分钟前');

  const enEventMap = en.tasks.queue.eventTypes as Record<string, string>;
  const enSummary = formatQueueEventSummary(
    { ...ev, kind: 'task.completed', payload: {} },
    'en',
    {
      nowMs: NOW,
      resolveTitle: (kind, key) => (key ? enEventMap[key.split('.').pop()!] : kind),
    }
  );
  assert.equal(enSummary.title, 'Completed');
  assert.equal(enSummary.detail, 'coder');
  assert.equal(enSummary.time, '5m ago');

  const fallbackSummary = formatQueueEventSummary({ ...ev, kind: 'custom.event', payload: {} }, 'en', {
    nowMs: NOW,
  });
  assert.equal(fallbackSummary.title, 'custom.event');

  assert.deepEqual(getScheduleActions('pending'), ['approve', 'reject', 'run_now', 'cancel']);
  assert.deepEqual(getScheduleActions('in_progress'), ['cancel']);
  assert.deepEqual(getScheduleActions('failed'), ['run_now', 'cancel']);
  assert.deepEqual(getScheduleActions('completed'), []);
  assert.deepEqual(getScheduleActions('cancelled'), []);
});

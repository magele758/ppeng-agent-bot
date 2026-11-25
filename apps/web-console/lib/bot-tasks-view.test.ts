import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBotTaskBand,
  countBotTaskFacets,
  extractBotTaskPreview,
  extractBotTaskTitle,
  extractCollaborationPreview,
  extractCollaborationTitle,
  filterBotTasks,
  findDroppedUnresolvedIds,
  formatRelativeTime,
  getBotInitials,
  groupBotTasksByBand,
  isUnresolvedBotTask,
  mergePolledBotTasks,
  stepItemId,
  type BotTaskItem,
} from './bot-tasks-view.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

test('extractBotTaskTitle strips internal goal continuation boilerplate [AC:bot-tasks-queue-redesign#AC-2]', () => {
  const raw =
    'Continue goal goal_827c0bc9 under revision 1. Objective: 核对本周发布清单并输出摘要 Constraints: [] Previous progress: done Evidence: ["session_6dbf bash ok=true"]';
  const result = extractBotTaskTitle(raw, 'Untitled');
  assert.equal(result.title, '核对本周发布清单并输出摘要');
  assert.equal(result.isExtracted, true);
});

test('extractBotTaskTitle strips message/OPC OS wrappers and JSON schema instructions [AC:bot-tasks-queue-redesign#AC-2]', () => {
  const wrapped =
    'Message from Super Bot / bot_1: [OPC OS] OPC OS阶段工单：你是 OPC OS 代理拍板审查 Bot，负责审核阶段产出。严格只返回单个 JSON 对象：{"decision": "approve", "reason": "..."}';
  const result = extractBotTaskTitle(wrapped, 'Untitled');
  assert.equal(result.title, '你是 OPC OS 代理拍板审查 Bot，负责审核阶段产出');
  assert.equal(result.isExtracted, true);
  assert.equal(result.title.includes('JSON'), false);
});

test('extractBotTaskTitle preserves plain short user prompts verbatim [AC:bot-tasks-queue-redesign#AC-2]', () => {
  const plain = extractBotTaskTitle('新的工作', 'Untitled');
  assert.deepEqual(plain, { title: '新的工作', isExtracted: false });

  const empty = extractBotTaskTitle('   ', '空任务');
  assert.deepEqual(empty, { title: '空任务', isExtracted: false });
});

test('extractBotTaskTitle picks labeled line from multi-line prompts and clips long strings [AC:bot-tasks-queue-redesign#AC-2]', () => {
  const multi = '背景说明：自动生成工单\n目标：完成竞品对比分析报告\n补充：需要附链接';
  const extracted = extractBotTaskTitle(multi, 'Fallback');
  assert.equal(extracted.title, '完成竞品对比分析报告');
  assert.equal(extracted.isExtracted, true);

  const veryLong = 'A'.repeat(120);
  const clipped = extractBotTaskTitle(veryLong, 'Fallback');
  assert.equal(clipped.isExtracted, true);
  assert.ok(clipped.title.length <= 88);
  assert.ok(clipped.title.endsWith('…'));
});

test('extractBotTaskPreview prefers failure/delivery/result and avoids repeating cleanTitle [AC:bot-tasks-queue-redesign#AC-2]', () => {
  const failed: BotTaskItem = {
    id: 't1',
    targetBotId: 'b1',
    input: '检查生产告警',
    status: 'failed',
    failureReason: 'Connection unavailable',
    result: 'Ignored fallback',
  };
  assert.equal(extractBotTaskPreview(failed, '检查生产告警'), 'Connection unavailable');

  const delivered: BotTaskItem = {
    id: 't2',
    targetBotId: 'b1',
    input: '生成周报',
    status: 'completed',
    delivery: {
      taskId: 't2',
      sessionId: 's1',
      attempt: 1,
      createdAt: '2026-11-25T10:00:00Z',
      executionStatus: 'completed',
      report: '# 本周发布完成\n全部测试通过',
      failureReason: null,
      verification: 'unverified',
      artifacts: [],
      receipts: [],
    },
  };
  assert.equal(extractBotTaskPreview(delivered, '生成周报'), '本周发布完成');

  const dup: BotTaskItem = {
    id: 't3',
    targetBotId: 'b1',
    input: '生成周报',
    status: 'completed',
    result: '生成周报',
  };
  assert.equal(extractBotTaskPreview(dup, '生成周报'), '');

  assert.equal(extractCollaborationTitle('Continue goal g1. Objective: 联调验收 Constraints: []', '默认'), '联调验收');
  assert.equal(extractCollaborationPreview('## 汇总进度\n详情'), '汇总进度');
  assert.equal(extractCollaborationPreview(undefined), '');
});

test('classifyBotTaskBand and groupBotTasksByBand separate attention, active, and history [AC:bot-tasks-queue-redesign#AC-3]', () => {
  const tasks: BotTaskItem[] = [
    { id: '1', targetBotId: 'b1', input: 'A', status: 'failed' },
    { id: '2', targetBotId: 'b1', input: 'B', status: 'waiting_approval' },
    { id: '3', targetBotId: 'b1', input: 'C', status: 'unknown' },
    { id: '4', targetBotId: 'b1', input: 'D', status: 'running' },
    { id: '5', targetBotId: 'b2', input: 'E', status: 'queued' },
    { id: '6', targetBotId: 'b2', input: 'F', status: 'completed' },
    { id: '7', targetBotId: 'b2', input: 'G', status: 'completed', deliveryReview: { accepted: false, at: '2026-11-25T10:00:00Z' } },
    { id: '8', targetBotId: 'b2', input: 'H', status: 'cancelled' },
  ];

  assert.equal(classifyBotTaskBand(tasks[0]), 'attention');
  assert.equal(classifyBotTaskBand(tasks[3]), 'active');
  assert.equal(classifyBotTaskBand(tasks[5]), 'history');
  assert.equal(classifyBotTaskBand(tasks[6]), 'attention');
  assert.equal(isUnresolvedBotTask(tasks[3]), true);
  assert.equal(isUnresolvedBotTask(tasks[5]), false);

  const grouped = groupBotTasksByBand(tasks);
  assert.deepEqual(grouped.attention.map((t) => t.id), ['1', '2', '3', '7']);
  assert.deepEqual(grouped.active.map((t) => t.id), ['4', '5']);
  assert.deepEqual(grouped.history.map((t) => t.id), ['6', '8']);
});

test('filterBotTasks and countBotTaskFacets filter by query, bot, band, and time range [AC:bot-tasks-queue-redesign#AC-3]', () => {
  const botNames = new Map([
    ['bot_a', '研发助手'],
    ['bot_b', '运维专员'],
  ]);
  const tasks: BotTaskItem[] = [
    { id: 't1', targetBotId: 'bot_a', input: '修复登录问题', status: 'failed', updatedAt: new Date(NOW - 2 * HOURS).toISOString() },
    { id: 't2', targetBotId: 'bot_a', input: '同步文档', status: 'running', updatedAt: new Date(NOW - 2 * DAYS).toISOString() },
    { id: 't3', targetBotId: 'bot_b', input: '巡检集群', status: 'completed', updatedAt: new Date(NOW - 5 * DAYS).toISOString() },
    { id: 't4', targetBotId: 'bot_b', input: '旧归档任务', status: 'completed', createdAt: new Date(NOW - 12 * DAYS).toISOString() },
  ];

  const counts = countBotTaskFacets(tasks, botNames, NOW);
  assert.equal(counts.total, 4);
  assert.deepEqual(counts.byBand, { attention: 1, active: 1, history: 2 });
  assert.deepEqual(counts.byBot, { bot_a: 2, bot_b: 2 });
  assert.deepEqual(counts.byTime, { all: 4, today: 1, '3d': 2, '7d': 3 });

  assert.deepEqual(
    filterBotTasks(tasks, { query: '研发助手', botId: '', band: 'all', timeRange: 'all' }, botNames, NOW).map((t) => t.id),
    ['t1', 't2']
  );
  assert.deepEqual(
    filterBotTasks(tasks, { query: '', botId: 'bot_b', band: 'history', timeRange: '7d' }, botNames, NOW).map((t) => t.id),
    ['t3']
  );
  assert.deepEqual(
    filterBotTasks(tasks, { query: '', botId: '', band: 'all', timeRange: 'today' }, { bot_a: '研发助手' }, NOW).map((t) => t.id),
    ['t1']
  );
});

test('mergePolledBotTasks retains older history across polls while updating finished items [AC:bot-tasks-queue-redesign#AC-3]', () => {
  const prev: BotTaskItem[] = [
    { id: 'active-1', targetBotId: 'b1', input: 'Run', status: 'running' },
    { id: 'older-1', targetBotId: 'b1', input: 'Old', status: 'completed' },
  ];
  const incoming = {
    activeTasks: [],
    historyTasks: [{ id: 'recent-new', targetBotId: 'b1', input: 'New', status: 'completed' }],
  };
  assert.deepEqual(findDroppedUnresolvedIds(prev, incoming), ['active-1']);

  const merged = mergePolledBotTasks(incoming, prev, true, {
    resolvedFinished: [{ id: 'active-1', targetBotId: 'b1', input: 'Run', status: 'completed', result: 'ok' }],
  });
  assert.deepEqual(merged.map((t) => t.id), ['older-1', 'active-1']);
  assert.equal(merged.find((t) => t.id === 'active-1')?.status, 'completed');

  const unpaged = mergePolledBotTasks(
    { tasks: [{ id: 'fresh', targetBotId: 'b1', input: 'Fresh', status: 'queued' }], activeTasks: [], historyTasks: [] },
    prev,
    false
  );
  assert.deepEqual(unpaged.map((t) => t.id), ['fresh']);
});

test('formatRelativeTime, getBotInitials, and stepItemId support readable row headers and detail navigation [AC:bot-tasks-queue-redesign#AC-4]', () => {
  assert.equal(formatRelativeTime(new Date(NOW - 15_000).toISOString(), 'zh', NOW), '刚刚');
  assert.equal(formatRelativeTime(new Date(NOW - 15_000).toISOString(), 'en', NOW), 'Just now');
  assert.equal(formatRelativeTime(new Date(NOW - 12 * 60_000).toISOString(), 'zh', NOW), '12 分钟前');
  assert.equal(formatRelativeTime(new Date(NOW - 3 * HOURS).toISOString(), 'en', NOW), '3h ago');
  assert.equal(formatRelativeTime(new Date(NOW - 2 * DAYS).toISOString(), 'zh', NOW), '2 天前');
  assert.equal(formatRelativeTime('2026-10-05T08:00:00Z', 'zh', NOW), '10-05');
  assert.equal(formatRelativeTime('2025-10-05T08:00:00Z', 'en', NOW), '2025-10-05');
  assert.equal(formatRelativeTime(undefined, 'zh', NOW), '');

  assert.equal(getBotInitials('Super Bot'), 'SB');
  assert.equal(getBotInitials('coder'), 'CO');
  assert.equal(getBotInitials('研发助手'), '研');
  assert.equal(getBotInitials(''), '?');

  assert.equal(stepItemId(['a', 'b', 'c'], 'b', -1), 'a');
  assert.equal(stepItemId(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(stepItemId(['a', 'b', 'c'], 'a', -1), null);
  assert.equal(stepItemId(['a', 'b', 'c'], 'c', 1), null);
  assert.equal(stepItemId(['a', 'b'], null, 1), 'a');
  assert.equal(stepItemId([], null, 1), null);
});

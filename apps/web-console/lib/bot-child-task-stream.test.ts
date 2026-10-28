import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSessionsByPlaySurface, type PlaySurface } from './bots.ts';
import { placeChildTaskEntries, streamChildTaskEntries } from './bot-child-task-stream.ts';
import type { BotInfo } from './types.ts';

const longA = '请把上周所有客户会议纪要按主题归类，并标出还没回复的行动项，最后写成一页摘要。TAIL-A-9f3c';
const longB = '对照三家竞品的公开标价和折扣规则，整理成一张表，标出我们更贵的项目。TAIL-B-77ab';
const goalText = '继续把目标拆成可核对的步骤';
const writerTask = '写发布说明';
const writerParent = '补上父会话里的任务说明';

const researcher = { id: 'researcher', canonicalSessionId: 'sess-researcher' };
const writer = { id: 'writer', canonicalSessionId: 'sess-writer' };

const sessions = [
  { id: 'sess-researcher', title: '资料员' },
  {
    id: 'sess-researcher-user',
    title: '资料员',
    metadata: { botId: 'researcher', canonicalBotChat: true }
  },
  { id: 'sess-writer', title: '写作者' },
  { id: 'chat-plain', title: '周末去哪玩' },
  { id: 'lookalike', title: '这不是子任务只是闲聊', metadata: { botId: 'researcher' } },
  {
    id: 'child-a',
    title: longA,
    metadata: { botId: 'researcher', botGoalWorker: true, spawnSource: 'bot-goal-continuation' }
  },
  {
    id: 'child-b',
    title: longB,
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  },
  {
    id: 'child-goal',
    title: `Bot Chat · ${goalText}`,
    metadata: { botId: 'researcher', spawnSource: 'bot-goal-continuation' }
  },
  {
    id: 'child-c',
    title: writerTask,
    metadata: { botId: 'writer', botGoalWorker: true }
  },
  {
    id: 'child-parent',
    title: writerParent,
    metadata: { spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-writer' }
  }
];

function entriesFor(bot: { id: string; canonicalSessionId?: string | null }, currentId: string, surface: PlaySurface = 'bot') {
  return streamChildTaskEntries({
    surface,
    sessions,
    bot,
    current: sessions.find((session) => session.id === currentId) ?? null
  });
}

test('主对话流里的入口是各子任务原文的短摘 [AC:bot-child-task-stream-entry#AC-1]', () => {
  for (const currentId of ['sess-researcher', 'sess-researcher-user']) {
    const entries = entriesFor(researcher, currentId);
    assert.deepEqual(entries.map((entry) => entry.id), ['child-a', 'child-b', 'child-goal']);
    const byId = new Map(entries.map((entry) => [entry.id, entry.excerpt]));
    const excerptA = byId.get('child-a') ?? '';
    const excerptB = byId.get('child-b') ?? '';
    const excerptGoal = byId.get('child-goal') ?? '';
    assert.match(excerptA, /^请把上周所有客户/);
    assert.equal(excerptA.includes('TAIL-A-9f3c'), false);
    assert.ok(excerptA.length < longA.length);
    assert.ok(excerptA.length <= 32);
    assert.match(excerptB, /^对照三家竞品/);
    assert.equal(excerptB.includes('TAIL-B-77ab'), false);
    assert.ok(excerptB.length < longB.length);
    assert.equal(excerptGoal, goalText);
    assert.equal(excerptGoal.includes('Bot Chat'), false);
    assert.equal(entries.some((entry) => entry.id === 'lookalike' || entry.id === 'chat-plain'), false);
  }
});

test('主对话没有子任务时不给出入口 [AC:bot-child-task-stream-entry#AC-3]', () => {
  const quiet = sessions.filter((session) => session.id !== 'child-a' && session.id !== 'child-b' && session.id !== 'child-goal');
  const entries = streamChildTaskEntries({
    surface: 'bot',
    sessions: quiet,
    bot: researcher,
    current: quiet.find((session) => session.id === 'sess-researcher') ?? null
  });
  assert.deepEqual(entries, []);
});

test('另一只 Bot 的子任务不进这场主对话的入口 [AC:bot-child-task-stream-entry#AC-4]', () => {
  const mine = entriesFor(researcher, 'sess-researcher');
  const theirs = entriesFor(writer, 'sess-writer');
  assert.deepEqual(mine.map((entry) => entry.id), ['child-a', 'child-b', 'child-goal']);
  assert.equal(mine.some((entry) => entry.excerpt === writerTask || entry.excerpt === writerParent), false);
  assert.deepEqual(theirs.map((entry) => entry.excerpt), [writerTask, writerParent]);
  assert.equal(theirs.some((entry) => entry.excerpt.includes('TAIL-A') || entry.excerpt.includes('TAIL-B')), false);
});

test('子任务按生成时刻分开，更早的不堆到当前段末尾 [AC:bot-child-task-stream-entry#AC-7] [AC:bot-child-task-stream-entry#AC-8]', () => {
  const messages = [
    { id: 'early', createdAt: '2026-10-22T01:00:00.000Z' },
    { id: 'mid', createdAt: '2026-10-22T01:10:00.000Z' },
    { id: 'late', createdAt: '2026-10-22T02:00:00.000Z' }
  ];
  const placed = placeChildTaskEntries(messages, [
    { id: 'c-early', excerpt: '较早', title: '较早', sourceMessageId: 'early', createdAt: '2026-10-22T01:00:01.000Z' },
    { id: 'c-mid', excerpt: '中间', title: '中间', createdAt: '2026-10-22T01:20:00.000Z' },
    { id: 'c-late', excerpt: '较晚', title: '较晚', createdAt: '2026-10-22T02:00:01.000Z' },
    { id: 'c-old', excerpt: '更早', title: '更早', sourceMessageId: 'not-loaded', createdAt: '2026-10-22T00:00:00.000Z' }
  ]);
  assert.deepEqual(placed.get(0)?.map((entry) => entry.id), ['c-early']);
  assert.deepEqual(placed.get(1)?.map((entry) => entry.id), ['c-mid']);
  assert.deepEqual(placed.get(2)?.map((entry) => entry.id), ['c-late']);
  assert.equal([...placed.values()].some((group) => group.some((entry) => entry.id === 'c-old')), false);
});

test('入口记着生成它的那句话和生成时刻', () => {
  const timed = {
    id: 'child-timed',
    title: '整理本周纪要',
    createdAt: '2026-10-22T01:00:02.000Z',
    metadata: {
      botId: 'researcher',
      spawnSource: 'concurrent-bot-work',
      parentSessionId: 'sess-researcher',
      sourceMessageId: 'msg-early'
    }
  };
  const [entry] = streamChildTaskEntries({
    surface: 'bot',
    sessions: [sessions[0]!, timed],
    bot: researcher,
    current: sessions[0]
  });
  assert.equal(entry?.sourceMessageId, 'msg-early');
  assert.equal(entry?.createdAt, '2026-10-22T01:00:02.000Z');
});

test('普通聊天和正在看的子任务本身不出现这块入口', () => {
  assert.deepEqual(entriesFor(researcher, 'sess-researcher', 'chat'), []);
  assert.deepEqual(entriesFor(researcher, 'chat-plain'), []);
  assert.deepEqual(entriesFor(researcher, 'child-a'), []);
  const bots = [researcher, writer] as BotInfo[];
  const chatIds = filterSessionsByPlaySurface(sessions, bots, 'chat').map((session) => session.id);
  const botIds = filterSessionsByPlaySurface(sessions, bots, 'bot').map((session) => session.id);
  assert.equal(chatIds.includes('child-a'), true);
  assert.equal(chatIds.includes('child-c'), true);
  assert.equal(botIds.includes('child-a'), false);
  assert.equal(botIds.includes('sess-researcher'), true);
});

test('正在执行的子任务把 status 传到入口，其他状态也传但不表示要停 [AC:bot-child-task-stream-entry#AC-9]', () => {
  const running = {
    id: 'child-running',
    title: '正在整理纪要',
    status: 'running',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  };
  const idle = {
    id: 'child-idle',
    title: '已经整理完',
    status: 'idle',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  };
  const failed = {
    id: 'child-failed',
    title: '整理失败了',
    status: 'failed',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  };
  const entries = streamChildTaskEntries({
    surface: 'bot',
    sessions: [sessions[0]!, running, idle, failed],
    bot: researcher,
    current: sessions[0]
  });
  assert.deepEqual(entries.map((entry) => [entry.id, entry.status]), [
    ['child-running', 'running'],
    ['child-idle', 'idle'],
    ['child-failed', 'failed']
  ]);
  assert.equal(entries.length, 3);
});

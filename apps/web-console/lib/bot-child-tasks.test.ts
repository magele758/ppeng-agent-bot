import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { childTasksForBot, filterSessionsByPlaySurface, sessionForPinnedBot, sessionsForPlaySurface } from './bots.ts';
import { functionalGroupRows } from './functional-group-view.ts';
import { sessionRowCopy } from './session-row.ts';
import type { BotInfo, SessionSummary } from './types.ts';

function bot(id: string, canonicalSessionId: string): BotInfo {
  return {
    id,
    name: id,
    title: id,
    description: '',
    agentId: id,
    canonicalSessionId,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

const researcher = bot('researcher', 'sess-researcher');
const writer = bot('writer', 'sess-writer');
const bots = [researcher, writer];

const sessions = [
  { id: 'sess-researcher', title: '资料员', mode: 'chat', status: 'idle', agentId: 'researcher' },
  {
    id: 'sess-researcher-user',
    title: '资料员',
    mode: 'chat',
    status: 'idle',
    agentId: 'researcher',
    metadata: { botId: 'researcher', canonicalBotChat: true }
  },
  { id: 'sess-writer', title: '写作者', mode: 'chat', status: 'idle', agentId: 'writer' },
  { id: 'chat-1', title: '周末去哪', mode: 'chat', status: 'idle', agentId: 'general' },
  {
    id: 'plain-lookalike',
    title: '整理本周纪要',
    mode: 'chat',
    status: 'idle',
    agentId: 'researcher',
    metadata: { botId: 'researcher' }
  },
  {
    id: 'child-a',
    title: '整理本周纪要',
    mode: 'subagent',
    status: 'idle',
    agentId: 'researcher',
    metadata: { botId: 'researcher', botGoalWorker: true, spawnSource: 'bot-goal-continuation' }
  },
  {
    id: 'child-b',
    title: '对照竞品价格',
    mode: 'subagent',
    status: 'running',
    agentId: 'researcher',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  },
  {
    id: 'child-c',
    title: '写发布说明',
    mode: 'subagent',
    status: 'idle',
    agentId: 'writer',
    metadata: { botId: 'writer', botGoalWorker: true }
  },
  {
    id: 'child-parent',
    title: '补上父会话里的任务',
    mode: 'subagent',
    status: 'idle',
    agentId: 'writer',
    metadata: { spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-writer' }
  }
] as SessionSummary[];

const groups = [{ id: 'research', name: '调研', botIds: ['researcher'] }];
const childIds = ['child-a', 'child-b', 'child-c', 'child-parent'];

test('Bot 左侧列表不含子任务，分组数量也不计入，自己的对话留在原分组 [AC:bot-fork-sessions-in-detail#AC-1]', () => {
  const left = filterSessionsByPlaySurface(sessions, bots, 'bot');
  const botShelf = sessions.filter((session) => session.id !== 'chat-1' && session.id !== 'plain-lookalike');
  const research = functionalGroupRows(groups, bots, botShelf, 'research');
  const ungrouped = functionalGroupRows(groups, bots, botShelf, null);
  const fromLeft = {
    research: functionalGroupRows(groups, bots, left, 'research'),
    ungrouped: functionalGroupRows(groups, bots, left, null)
  };
  const shown = [...left, ...research, ...ungrouped, ...fromLeft.research, ...fromLeft.ungrouped].map((session) => session.id);

  for (const id of childIds) {
    assert.equal(shown.includes(id), false, id);
  }
  assert.deepEqual(research.map((session) => session.id), ['sess-researcher', 'sess-researcher-user']);
  assert.equal(research.length, 2);
  assert.deepEqual(ungrouped.map((session) => session.id), ['sess-writer']);
  assert.equal(ungrouped.length, 1);
  assert.deepEqual(fromLeft.research.map((session) => session.id), ['sess-researcher', 'sess-researcher-user']);
  assert.equal(fromLeft.research.length, 2);
  assert.deepEqual(fromLeft.ungrouped.map((session) => session.id), ['sess-writer']);
  assert.equal(fromLeft.ungrouped.length, 1);
  assert.deepEqual(left.map((session) => session.id), ['sess-researcher', 'sess-researcher-user', 'sess-writer']);
});

test('两只 Bot 的子任务按 Bot 分开，标题是任务原文 [AC:bot-fork-sessions-in-detail#AC-2]', async () => {
  const botsModule = await import('./bots.ts');
  const childTasksForBot = (botsModule as { childTasksForBot?: (
    rows: readonly SessionSummary[],
    bot: { id: string; canonicalSessionId?: string | null }
  ) => SessionSummary[] }).childTasksForBot;
  assert.equal(typeof childTasksForBot, 'function');
  const mine = childTasksForBot!(sessions, researcher).map((session) => session.title);
  const theirs = childTasksForBot!(sessions, writer).map((session) => session.title);
  assert.deepEqual(mine, ['整理本周纪要', '对照竞品价格']);
  assert.deepEqual(theirs, ['写发布说明', '补上父会话里的任务']);

  const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  const menu = readFileSync(new URL('../components/BotDetailMenu.tsx', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('../components/sections/chat/ChatSection.tsx', import.meta.url), 'utf8');
  assert.match(panel, /childTasksForBot\(/);
  assert.match(menu, /data-testid="bot-detail-child-task"/);
  assert.match(chat, /catalogSessions=\{sessions\}/);
});

test('普通会话列表有子任务，Bot 左侧没有 [AC:bot-fork-sessions-in-detail#AC-5]', () => {
  const chat = sessionsForPlaySurface(sessions, bots, 'chat', 'child-a');
  const botLeft = sessionsForPlaySurface(sessions, bots, 'bot', 'child-a');
  for (const id of childIds) {
    assert.equal(chat.some((session) => session.id === id), true, id);
    assert.equal(botLeft.some((session) => session.id === id), false, id);
  }
  assert.equal(chat.filter((session) => session.id === 'child-a').length, 1);
});

function chatList(rows: SessionSummary[] = sessions, selectedId: string | null = null) {
  return sessionsForPlaySurface(rows, bots, 'chat', selectedId);
}

test('打开的子任务出现在普通会话列表 [AC:bot-child-task-chat-entry#AC-2]', () => {
  const list = chatList(sessions, 'child-a');
  assert.equal(list.filter((session) => session.id === 'child-a').length, 1);
});

test('同一只 Bot 的其他子任务也在普通会话列表 [AC:bot-child-task-chat-entry#AC-6]', () => {
  const list = chatList(sessions, 'child-a');
  assert.equal(list.some((session) => session.id === 'child-b'), true);
  assert.equal(list.filter((session) => session.id === 'child-b').length, 1);
});

test('另一只 Bot 的子任务也在普通会话列表且能靠 botId 区分 [AC:bot-child-task-chat-entry#AC-7]', () => {
  const list = chatList();
  const researcherTask = list.find((session) => session.id === 'child-a');
  const writerTask = list.find((session) => session.id === 'child-c');
  const writerByParent = list.find((session) => session.id === 'child-parent');
  assert.ok(researcherTask);
  assert.ok(writerTask);
  assert.ok(writerByParent);
  assert.equal(researcherTask.metadata?.botId, 'researcher');
  assert.equal(writerTask.metadata?.botId, 'writer');
  assert.notEqual(researcherTask.metadata?.botId, writerTask.metadata?.botId);
});

test('Bot 左侧未分组、功能分组和置顶不出现子任务 [AC:bot-child-task-chat-entry#AC-8]', () => {
  const botLeft = sessionsForPlaySurface(sessions, bots, 'bot', 'child-a');
  const research = functionalGroupRows(groups, bots, sessions, 'research');
  const ungrouped = functionalGroupRows(
    groups,
    bots,
    sessions.filter((session) => session.id !== 'chat-1' && session.id !== 'plain-lookalike'),
    null
  );
  const pins = [researcher, writer].flatMap((bot) => {
    const row = sessionForPinnedBot(bot, bots, sessions);
    return row ? [row] : [];
  });
  const shown = [...botLeft, ...research, ...ungrouped, ...pins].map((session) => session.id);
  for (const id of childIds) {
    assert.equal(shown.includes(id), false, id);
  }
  assert.deepEqual(pins.map((session) => session.id), ['sess-researcher', 'sess-writer']);
});

test('子任务不计入 Bot 左侧未分组、功能分组和置顶的数量 [AC:bot-child-task-chat-entry#AC-9]', () => {
  const botLeft = sessionsForPlaySurface(sessions, bots, 'bot', 'child-a');
  const research = functionalGroupRows(groups, bots, botLeft, 'research');
  const ungrouped = functionalGroupRows(groups, bots, botLeft, null);
  const researchWithChildren = functionalGroupRows(groups, bots, sessions, 'research');
  const ungroupedShelf = functionalGroupRows(
    groups,
    bots,
    sessions.filter((session) => session.id !== 'chat-1' && session.id !== 'plain-lookalike'),
    null
  );
  const pins = [researcher, writer].flatMap((bot) => {
    const row = sessionForPinnedBot(bot, bots, sessions);
    return row ? [row] : [];
  });
  assert.equal(research.length, 2);
  assert.equal(ungrouped.length, 1);
  assert.equal(researchWithChildren.length, 2);
  assert.equal(ungroupedShelf.length, 1);
  assert.equal(pins.length, 2);
  assert.equal(botLeft.length, 3);
});

test('普通聊天会话仍在普通会话列表 [AC:bot-child-task-chat-entry#AC-10]', () => {
  const list = chatList();
  assert.equal(list.some((session) => session.id === 'chat-1'), true);
  assert.equal(list.some((session) => session.id === 'plain-lookalike'), true);
  assert.equal(list.some((session) => session.id === 'child-a'), true);
});

test('没有子任务时普通会话列表不多出空入口 [AC:bot-child-task-chat-entry#AC-11]', () => {
  const quiet = sessions.filter((session) => !childIds.includes(session.id));
  const list = chatList(quiet);
  assert.deepEqual(list.map((session) => session.id), ['chat-1', 'plain-lookalike']);
});

const spoken = {
  id: 'spoken',
  title: '你写到我项目里了？我是让你沉淀到自己的bot的skill目录里',
  mode: 'subagent',
  status: 'idle',
  agentId: 'researcher',
  parentSessionId: 'sess-researcher',
  metadata: {
    botId: 'researcher',
    parentSessionId: 'sess-researcher',
    spawnSource: 'bot-goal-continuation'
  }
} as SessionSummary;

const unmarked = {
  id: 'unmarked-sub',
  title: '同类子任务',
  mode: 'subagent',
  status: 'idle',
  agentId: 'researcher',
  parentSessionId: 'sess-researcher',
  metadata: { botId: 'researcher', parentSessionId: 'sess-researcher' }
} as SessionSummary;

const ownedChat = {
  id: 'owned-chat',
  title: '我自己的普通会话',
  mode: 'chat',
  status: 'idle',
  agentId: 'general',
  parentSessionId: 'sess-researcher',
  metadata: { botId: 'researcher', parentSessionId: 'sess-researcher' }
} as SessionSummary;

const leakedRows = [...sessions, spoken, unmarked, ownedChat];

test('用户原话标题的子任务和没有派生来源的子代理都不出现在 Bot 侧栏分组 [AC:bot-sidebar-child-sessions#AC-1]', () => {
  const botLeft = sessionsForPlaySurface(leakedRows, bots, 'bot', 'spoken');
  const research = functionalGroupRows(groups, bots, leakedRows, 'research');
  const ungrouped = functionalGroupRows(groups, bots, leakedRows, null);
  const pins = [researcher, writer].flatMap((bot) => {
    const row = sessionForPinnedBot(bot, bots, leakedRows);
    return row ? [row] : [];
  });
  const shown = [...botLeft, ...research, ...ungrouped, ...pins].map((session) => session.id);
  assert.equal(shown.includes('spoken'), false);
  assert.equal(shown.includes('unmarked-sub'), false);
  assert.equal(research.filter((session) => session.id === 'sess-researcher' || session.id === 'sess-researcher-user').length, 2);
  assert.equal(pins.some((session) => session.id === 'sess-researcher'), true);
  assert.equal(ungrouped.some((session) => session.id === 'sess-writer'), true);
});

test('子任务仍在普通会话列表，主对话也能按任务原文找到它 [AC:bot-sidebar-child-sessions#AC-2]', () => {
  const chat = sessionsForPlaySurface(leakedRows, bots, 'chat', 'spoken');
  assert.equal(chat.some((session) => session.id === 'spoken'), true);
  assert.equal(chat.some((session) => session.id === 'unmarked-sub'), true);
  const titles = childTasksForBot(leakedRows, researcher).map((session) => session.title);
  assert.equal(titles.includes(spoken.title), true);
  assert.equal(titles.includes(unmarked.title), true);
  const copy = sessionRowCopy({
    session: spoken,
    bots,
    question: '',
    emptyHint: '空',
    unnamed: '未命名'
  });
  assert.equal(copy.kind, 'child-task');
  assert.equal(copy.kind === 'child-task' ? copy.title : '', spoken.title);
});

test('Bot 自己的对话和用户普通会话仍留在各自列表 [AC:bot-sidebar-child-sessions#AC-3]', () => {
  const botLeft = filterSessionsByPlaySurface(leakedRows, bots, 'bot');
  const chat = filterSessionsByPlaySurface(leakedRows, bots, 'chat');
  assert.equal(botLeft.some((session) => session.id === 'sess-researcher'), true);
  assert.equal(botLeft.some((session) => session.id === 'sess-researcher-user'), true);
  assert.equal(chat.some((session) => session.id === 'chat-1'), true);
  assert.equal(chat.some((session) => session.id === 'owned-chat'), true);
  assert.equal(botLeft.some((session) => session.id === 'owned-chat'), false);
  const plain = sessionRowCopy({
    session: ownedChat,
    bots,
    question: '',
    emptyHint: '空',
    unnamed: '未命名'
  });
  assert.equal(plain.kind, 'plain');
  const canon = sessionRowCopy({
    session: leakedRows.find((session) => session.id === 'sess-researcher-user')!,
    bots,
    question: '在吗',
    emptyHint: '空',
    unnamed: '未命名'
  });
  assert.equal(canon.kind, 'bot');
});

test('没有子任务的 Bot 不多出空入口 [AC:bot-child-task-chat-entry#AC-12]', () => {
  const writerQuiet = sessions.filter((session) => session.id !== 'child-c' && session.id !== 'child-parent');
  const list = chatList(writerQuiet);
  assert.deepEqual(list.map((session) => session.id), ['chat-1', 'plain-lookalike', 'child-a', 'child-b']);
  assert.equal(list.some((session) => session.metadata?.botId === 'writer'), false);
  assert.equal(list.some((session) => !session.id), false);
});

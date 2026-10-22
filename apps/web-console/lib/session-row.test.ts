import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { displayedQuestion, lastUserQuestion, sessionRowCopy, sessionWorkBotId } from './session-row.ts';
import type { BotInfo } from './types.ts';

function bot(over: Partial<BotInfo> & Pick<BotInfo, 'id' | 'name'>): BotInfo {
  return {
    title: over.name,
    description: '',
    agentId: over.id,
    canonicalSessionId: '',
    hidden: false,
    createdAt: '',
    updatedAt: '',
    ...over
  };
}

const superBot = bot({ id: 'super-bot', name: 'Super Bot', canonicalSessionId: 'sess-bot-super' });
const emptyHint = '还没提问';
const unnamed = '未命名';

test('bot row title is the bot name and the subtitle is the last user question [AC:bot-session-row#AC-1]', () => {
  const copy = sessionRowCopy({
    session: {
      id: 'sess-bot-super',
      title: 'Bot Chat · Super Bot',
      agentId: 'super-bot',
      metadata: { botId: 'super-bot', canonicalBotChat: true }
    },
    bots: [superBot],
    question: '今天天气怎么样\n顺便看下日历',
    emptyHint,
    unnamed
  });
  assert.equal(copy.kind, 'bot');
  if (copy.kind !== 'bot') return;
  assert.equal(copy.title, 'Super Bot');
  assert.equal(copy.faceName, 'Super Bot');
  assert.equal(copy.subtitle, '今天天气怎么样 顺便看下日历');
  assert.equal(copy.hasQuestion, true);
  assert.equal(copy.subtitle.includes('\n'), false);
  assert.equal(copy.title.includes('Bot Chat'), false);
  assert.notEqual(copy.subtitle, 'super-bot');
  assert.notEqual(copy.faceName, 'super-bot');
});

test('a bot row with no user question uses the empty hint instead of the id [AC:bot-session-row#AC-2]', () => {
  const copy = sessionRowCopy({
    session: {
      id: 'sess-xiaoba',
      title: 'Bot Chat · 小八',
      agentId: 'bot-xiaoba',
      metadata: { botId: 'bot-xiaoba', canonicalBotChat: true }
    },
    bots: [bot({ id: 'bot-xiaoba', name: '小八', canonicalSessionId: 'sess-xiaoba' })],
    question: '  \n  ',
    emptyHint,
    unnamed
  });
  assert.equal(copy.kind, 'bot');
  if (copy.kind !== 'bot') return;
  assert.equal(copy.title, '小八');
  assert.equal(copy.subtitle, emptyHint);
  assert.equal(copy.hasQuestion, false);
  assert.notEqual(copy.subtitle, 'bot-xiaoba');
});

test('last user question skips assistant text and the memory appendix [AC:bot-session-row#AC-1]', () => {
  const question = lastUserQuestion([
    { role: 'user', parts: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', parts: [{ type: 'text', text: '回答' }] },
    {
      role: 'user',
      parts: [{ type: 'text', text: '本轮相关记忆与用户背景（仅供参考）' }, { type: 'text', text: '第二问' }]
    }
  ]);
  assert.equal(question, '第二问');
  assert.equal(
    displayedQuestion(
      [{ role: 'user', parts: [{ type: 'text', text: '已经发出' }] }],
      '正在输入的下一问'
    ),
    '正在输入的下一问'
  );
  assert.equal(
    displayedQuestion([{ role: 'user', parts: [{ type: 'text', text: '已经发出' }] }], '…'),
    '已经发出'
  );
});

test('last user question skips dragged file bodies', () => {
  const question = lastUserQuestion([
    {
      role: 'user',
      parts: [
        { type: 'text', text: '只发给这个 Bot' },
        { type: 'text', text: '«external source=attachment label=a.txt»\nalpha-file-sentence\n«end external»' }
      ]
    }
  ]);
  assert.equal(question, '只发给这个 Bot');
});

test('ordinary sessions and group rooms keep their own titles [AC:bot-session-row#AC-5]', () => {
  const ordinary = sessionRowCopy({
    session: { id: 'sess-chat', title: 'Deploy review', agentId: 'general', metadata: {} },
    bots: [superBot],
    question: 'ignored',
    emptyHint,
    unnamed
  });
  assert.deepEqual(ordinary, { kind: 'plain', title: 'Deploy review' });

  const room = sessionRowCopy({
    session: {
      id: 'sess-room',
      title: '晨会',
      agentId: 'deskbot',
      metadata: { roomId: 'room-1', botId: 'deskbot', canonicalBotChat: true }
    },
    bots: [superBot],
    question: 'ignored',
    emptyHint,
    unnamed
  });
  assert.deepEqual(room, { kind: 'plain', title: '晨会' });
});

test('a canonical chat missing from the roster does not fall back to the raw id [AC:bot-session-row#AC-2]', () => {
  const copy = sessionRowCopy({
    session: {
      id: 'sess-orphan',
      title: 'Bot Chat · super-bot',
      agentId: 'super-bot',
      metadata: { botId: 'super-bot', canonicalBotChat: true }
    },
    bots: [],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(copy.kind, 'bot');
  if (copy.kind !== 'bot') return;
  assert.equal(copy.title, unnamed);
  assert.equal(copy.faceName, '');
  assert.equal(copy.subtitle, emptyHint);
});

test('work identity prefers canonical roster then metadata and ignores invalid identifiers', () => {
  assert.equal(sessionWorkBotId({ id: 'sess-bot-super', metadata: { botId: 'wrong' } }, [superBot]), superBot.id);
  assert.equal(sessionWorkBotId({ id: 'other', metadata: { botId: 'standalone' } }, []), 'standalone');
  assert.equal(sessionWorkBotId({ id: 'other', metadata: { botId: 42 } }, []), '');
  assert.equal(sessionWorkBotId({ id: 'other' }, []), '');
});

const longBotId = `bot_${'cd'.repeat(16)}`;
const childSessionId = 'sess_9f3c0a1b2c3d4e5f';

function childSession(id: string, title: string, botId: string) {
  return {
    id,
    title,
    agentId: botId,
    metadata: { botId, spawnSource: 'bot-goal-continuation' as const, botGoalWorker: true }
  };
}

test('点开 Bot 详情里的子任务，主区打开的就是这条子任务 [AC:bot-child-task-chat-entry#AC-1]', () => {
  const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  const menu = readFileSync(new URL('../components/BotDetailMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /data-session-id=\{task\.id\}/);
  assert.match(menu, /onOpen\?\.\(task\.id\)/);
  const start = panel.indexOf('onOpenChildTask=');
  const end = panel.indexOf('}}', start);
  assert.ok(start >= 0 && end > start);
  const handler = panel.slice(start, end + 2);
  assert.match(handler, /onSelectSession\(sessionId\)/);
  assert.equal(handler.includes('canonicalSessionId'), false);
  assert.equal(handler.includes('.botId'), false);
});

test('子任务入口标题是任务原文，不是裸的 bot id [AC:bot-child-task-chat-entry#AC-4]', () => {
  const named = bot({ id: longBotId, name: '资料员', canonicalSessionId: 'sess-canon-researcher' });
  const prefixed = sessionRowCopy({
    session: childSession('child-a', 'Bot Chat · 整理本周纪要', longBotId),
    bots: [named],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(prefixed.kind, 'child-task');
  if (prefixed.kind !== 'child-task') return;
  assert.equal(prefixed.title, '整理本周纪要');
  assert.equal(prefixed.title.includes('Bot Chat'), false);
  assert.notEqual(prefixed.title, longBotId);
  assert.notEqual(prefixed.title, 'child-a');

  const bare = sessionRowCopy({
    session: childSession('child-bare', longBotId, longBotId),
    bots: [named],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(bare.kind, 'child-task');
  if (bare.kind !== 'child-task') return;
  assert.equal(bare.title, unnamed);
  assert.notEqual(bare.title, longBotId);
  assert.notEqual(bare.title, 'child-bare');
});

test('子任务入口显示所属 Bot 的名字，而不是一长串 id [AC:bot-child-task-chat-entry#AC-5]', () => {
  const named = bot({ id: longBotId, name: '资料员', canonicalSessionId: 'sess-canon-researcher' });
  const copy = sessionRowCopy({
    session: childSession(childSessionId, '整理本周纪要', longBotId),
    bots: [named],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(copy.kind, 'child-task');
  if (copy.kind !== 'child-task') return;
  assert.equal(copy.title, '整理本周纪要');
  assert.equal(copy.ownerName, '资料员');
  assert.equal(copy.ownerName.includes(longBotId), false);
  assert.notEqual(copy.title, childSessionId);
  assert.notEqual(copy.ownerName, childSessionId);
});

test('没有 Bot 名字时用可读短标记，标题不用会话 id [AC:bot-child-task-chat-entry#AC-5]', () => {
  const nameless = bot({ id: longBotId, name: ' ', title: ' ', canonicalSessionId: 'sess-canon-nameless' });
  const copy = sessionRowCopy({
    session: childSession(childSessionId, '整理本周纪要', longBotId),
    bots: [nameless],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(copy.kind, 'child-task');
  if (copy.kind !== 'child-task') return;
  assert.equal(copy.title, '整理本周纪要');
  assert.notEqual(copy.title, childSessionId);
  assert.notEqual(copy.ownerName, longBotId);
  assert.equal(copy.ownerName, 'CDCD');
  assert.ok(copy.ownerName.length > 0 && copy.ownerName.length <= 8);

  const titled = bot({ id: longBotId, name: '', title: '值班助手', canonicalSessionId: 'sess-canon-titled' });
  const byTitle = sessionRowCopy({
    session: childSession(childSessionId, '整理本周纪要', longBotId),
    bots: [titled],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(byTitle.kind, 'child-task');
  if (byTitle.kind !== 'child-task') return;
  assert.equal(byTitle.ownerName, '值班助手');
  assert.notEqual(byTitle.ownerName, longBotId);
  assert.notEqual(byTitle.title, childSessionId);

  const slug = bot({ id: 'ada', name: '', title: '', canonicalSessionId: 'sess-ada-canon' });
  const slugCopy = sessionRowCopy({
    session: childSession('sess_child_not_title', '把纪要发给我', 'ada'),
    bots: [slug],
    question: '',
    emptyHint,
    unnamed
  });
  assert.equal(slugCopy.kind, 'child-task');
  if (slugCopy.kind !== 'child-task') return;
  assert.equal(slugCopy.ownerName, 'ada');
  assert.equal(slugCopy.title, '把纪要发给我');
  assert.notEqual(slugCopy.title, 'sess_child_not_title');
  assert.notEqual(slugCopy.title, 'ada');
});

test('只有子任务会话才标归属，普通会话仍用自己的标题', () => {
  const copy = sessionRowCopy({
    session: {
      id: 'plain-lookalike',
      title: '整理本周纪要',
      agentId: 'researcher',
      metadata: { botId: 'researcher' }
    },
    bots: [bot({ id: 'researcher', name: '资料员', canonicalSessionId: 'sess-canon-researcher' })],
    question: 'ignored',
    emptyHint,
    unnamed
  });
  assert.deepEqual(copy, { kind: 'plain', title: '整理本周纪要' });
});

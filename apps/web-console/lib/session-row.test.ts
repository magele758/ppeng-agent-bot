import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedQuestion, lastUserQuestion, sessionRowCopy } from './session-row.ts';
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

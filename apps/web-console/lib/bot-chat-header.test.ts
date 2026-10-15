import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_PERMISSIONS_SECTION_ID,
  botChatHeaderTitle,
  botNameFromCanonicalTitle,
  botPermissionsHref,
  readBotPermissionsTarget
} from './bot-chat-header.ts';

test('Bot 对话标题只显示名字 [AC:bot-chat-header#AC-1]', () => {
  assert.equal(
    botChatHeaderTitle({
      botChat: true,
      botName: 'Super Bot',
      sessionTitle: 'Bot Chat · Super Bot'
    }),
    'Super Bot'
  );
  assert.equal(
    botChatHeaderTitle({
      botChat: true,
      botName: '小八',
      sessionTitle: 'Bot Chat · 小八'
    }),
    '小八'
  );
  assert.equal(
    botChatHeaderTitle({
      botChat: true,
      botName: '  DeskBot  ',
      sessionTitle: 'Bot Chat · Other'
    }),
    'DeskBot'
  );
  assert.equal(
    botChatHeaderTitle({
      botChat: true,
      botName: '',
      sessionTitle: 'Bot Chat · Super Bot'
    }),
    'Super Bot'
  );
  assert.equal(botNameFromCanonicalTitle('Bot Chat · 小八'), '小八');
  assert.equal(botNameFromCanonicalTitle('下午的调研'), '');
});

test('普通会话标题保持原样 [AC:bot-chat-header#AC-2]', () => {
  assert.equal(
    botChatHeaderTitle({
      botChat: false,
      botName: 'Super Bot',
      sessionTitle: '下午的调研'
    }),
    '下午的调研'
  );
  assert.equal(
    botChatHeaderTitle({
      botChat: false,
      sessionTitle: 'Bot Chat · Super Bot'
    }),
    'Bot Chat · Super Bot'
  );
  assert.equal(
    botChatHeaderTitle({
      botChat: false,
      sessionTitle: ''
    }),
    ''
  );
});

test('权限入口指向这只 Bot 已有的权限设置 [AC:bot-chat-header#AC-3]', () => {
  const href = botPermissionsHref('super-bot');
  assert.equal(href, '#/agents/bots?bot=super-bot&focus=permissions');
  assert.deepEqual(readBotPermissionsTarget(href), { botId: 'super-bot' });
  assert.equal(BOT_PERMISSIONS_SECTION_ID, 'bot-permissions');

  const encoded = botPermissionsHref('bot a/b');
  assert.deepEqual(readBotPermissionsTarget(encoded), { botId: 'bot a/b' });
  assert.equal(readBotPermissionsTarget('#/agents/bots'), null);
  assert.equal(readBotPermissionsTarget('#/agents/bots?bot=super-bot'), null);
  assert.equal(readBotPermissionsTarget('#/chat?bot=super-bot&focus=permissions'), null);
  assert.equal(readBotPermissionsTarget('#/agents/bots?focus=permissions'), null);
});

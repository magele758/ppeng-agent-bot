import test from 'node:test';
import assert from 'node:assert/strict';
import { planBotComposerSend, botComposerStatusText } from './bot-chat-commands.ts';
import { translate } from './i18n/t.ts';
import { zh } from './i18n/messages/zh/index.ts';
import type { MessageKey } from './i18n/messages/types.ts';

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(zh, key, vars);

test('选中 Bot 时 /new /stop /model 走命令，否则仍是普通消息 [AC:bot-forever-chat#AC-4]', () => {
  assert.equal(planBotComposerSend({ botSelected: true, text: '/new', hasAttachments: false }), 'command');
  assert.equal(planBotComposerSend({ botSelected: true, text: '  /STOP  ', hasAttachments: false }), 'command');
  assert.equal(planBotComposerSend({ botSelected: true, text: '/model beta-1', hasAttachments: false }), 'command');
  assert.equal(planBotComposerSend({ botSelected: true, text: '/model default', hasAttachments: false }), 'command');
  assert.equal(planBotComposerSend({ botSelected: false, text: '/new', hasAttachments: false }), 'message');
  assert.equal(planBotComposerSend({ botSelected: true, text: '/new', hasAttachments: true }), 'message');
  assert.equal(planBotComposerSend({ botSelected: true, text: '/new please', hasAttachments: false }), 'message');
  assert.equal(planBotComposerSend({ botSelected: true, text: 'hello', hasAttachments: false }), 'message');

  assert.match(botComposerStatusText(t, { code: 'compacted', ok: true }).text, /同一条|压缩/);
  assert.equal(botComposerStatusText(t, { code: 'compacted', ok: true }).err, false);
  assert.equal(botComposerStatusText(t, { code: 'model_unknown', ok: false, arg: 'nope' }).err, true);
  assert.match(botComposerStatusText(t, { code: 'model_set', ok: true, modelOverride: { modelId: 'beta-1' } }).text, /beta-1/);
});

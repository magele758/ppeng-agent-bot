import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_PIN_FORBIDDEN, botPinErrorText } from './bot-pin-error.ts';
import { translate } from './i18n/t.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

const CJK = /[\u3400-\u9fff]/;

test('a refused pin change reads as a permission message in zh and en [AC:bot-pin-permission#AC-1] [AC:bot-pin-permission#AC-2] [AC:bot-pin-permission#AC-6]', () => {
  const refused = new Error(BOT_PIN_FORBIDDEN);
  const zhText = botPinErrorText((key, vars) => translate(zh, key, vars), refused, 'fallback');
  const enText = botPinErrorText((key, vars) => translate(en, key, vars), refused, 'fallback');
  assert.match(zhText, /主人或管理员/);
  assert.match(enText, /owner or an admin/);
  assert.equal(CJK.test(enText), false);
  assert.equal(botPinErrorText((key) => translate(zh, key), new Error('HTTP 500'), 'HTTP 500'), 'HTTP 500');
  assert.equal(botPinErrorText((key) => translate(zh, key), BOT_PIN_FORBIDDEN, 'raw'), 'raw');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { botConnectionsHref, readBotConnectionsTarget } from './bot-recovery-link.ts';

test('task recovery links open the selected Bot connections without losing its identity [AC:bot-product-p0#AC-5]', () => {
  assert.deepEqual(readBotConnectionsTarget(botConnectionsHref('bot / 中文')), { botId: 'bot / 中文' });
  assert.equal(readBotConnectionsTarget('#/agents/bots?bot=other&focus=permissions'), null);
  assert.equal(readBotConnectionsTarget('#/tasks/bots?bot=other&focus=connections'), null);
});

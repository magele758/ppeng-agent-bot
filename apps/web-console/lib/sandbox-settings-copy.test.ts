import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

test('sandbox settings say the agent chooses isolation [AC:model-sandbox-isolation#AC-6]', () => {
  const zhSandbox = zh.settingsEntries.sandbox;
  const enSandbox = en.settingsEntries.sandbox;
  assert.match(zhSandbox.desc, /自己选/);
  assert.match(zhSandbox.desc, /不必/);
  assert.match(zhSandbox.risk.direct, /无隔离/);
  assert.match(enSandbox.desc, /agent chooses/i);
  assert.match(enSandbox.desc, /do not have to/i);
  assert.match(enSandbox.risk.direct, /no isolation/i);
  assert.match(zhSandbox.risk.container, /不会/);
  assert.equal(zhSandbox.risk.container.includes('实际按'), false);
  assert.equal(enSandbox.risk.container.toLowerCase().includes('runs directly'), false);
});

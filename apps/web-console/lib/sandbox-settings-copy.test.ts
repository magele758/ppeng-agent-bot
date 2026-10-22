import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

test('sandbox settings say the saved mode constrains shell [AC:model-sandbox-isolation#AC-6] [AC:saved-sandbox-mode-constrains-shell#AC-6]', () => {
  const zhSandbox = zh.settingsEntries.sandbox;
  const enSandbox = en.settingsEntries.sandbox;
  assert.match(zhSandbox.desc, /约束/);
  assert.match(zhSandbox.desc, /ssh/);
  assert.match(zhSandbox.options.mode.auto.desc, /系统沙箱/);
  assert.match(zhSandbox.options.mode.os.desc, /密钥目录/);
  assert.match(zhSandbox.options.mode.direct.desc, /ssh/);
  assert.equal(zhSandbox.options.mode.direct.desc.includes('不会因为保存'), false);
  assert.match(zhSandbox.risk.direct, /无隔离/);
  assert.equal(zhSandbox.risk.direct.includes('不会让对话里的命令去掉隔离'), false);
  assert.match(enSandbox.desc, /constrains/i);
  assert.match(enSandbox.desc, /ssh/);
  assert.match(enSandbox.options.mode.auto.desc, /OS sandbox/i);
  assert.match(enSandbox.risk.direct, /no isolation/i);
  assert.equal(enSandbox.risk.direct.toLowerCase().includes('does not turn isolation off'), false);
  assert.match(zhSandbox.risk.container, /不会/);
  assert.equal(zhSandbox.risk.container.includes('实际按'), false);
  assert.equal(enSandbox.risk.container.toLowerCase().includes('runs directly'), false);
});

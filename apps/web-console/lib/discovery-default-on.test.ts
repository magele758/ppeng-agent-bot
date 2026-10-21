import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsEntries as zhEntries } from './i18n/messages/zh/settingsEntries.ts';
import { settingsEntries as enEntries } from './i18n/messages/en/settingsEntries.ts';
import { configMessages as zhConfig } from './i18n/messages/zh/config.ts';
import { configMessages as enConfig } from './i18n/messages/en/config.ts';

test('能力发现说明标明总开关默认开启 [AC:discovery-default-on#AC-5]', () => {
  assert.equal(zhEntries.discovery.desc.includes('默认全部关闭'), false);
  assert.equal(enEntries.discovery.desc.includes('Everything is off by default'), false);
  assert.match(zhEntries.discovery.desc, /总开关默认开启/);
  assert.match(zhEntries.discovery.desc, /读取设备列表/);
  assert.match(zhEntries.discovery.desc, /主动扫描/);
  assert.match(enEntries.discovery.desc, /master switch is on by default/i);
  assert.match(enEntries.discovery.desc, /device list/i);
  assert.match(enEntries.discovery.desc, /active scanning/i);
  assert.match(zhEntries.discovery.fields.enabled.hint, /默认开启/);
  assert.match(enEntries.discovery.fields.enabled.hint, /on by default/i);
  assert.equal(zhConfig.reasonDefaultOn, '默认开启');
  assert.equal(enConfig.reasonDefaultOn, 'On by default');
  assert.equal(zhConfig.reasonManualOnly, '默认关闭，需要时手动开启');
  assert.equal(enConfig.reasonManualOnly, 'Off by default; enable it when you need it');
});

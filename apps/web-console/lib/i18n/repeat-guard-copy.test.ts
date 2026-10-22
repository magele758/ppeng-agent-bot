import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from './messages/en/index.ts';
import { zh } from './messages/zh/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('repeat detection has three settings labels and a stop reason in both languages [AC:loop-guard-model-switch#AC-1] [AC:loop-guard-model-switch#AC-5]', () => {
  const zhGuard = zh.settingsEntries.agentLoop.options.repeatGuard;
  const enGuard = en.settingsEntries.agentLoop.options.repeatGuard;
  assert.equal(zhGuard.weak.label, '仅弱模型');
  assert.equal(zhGuard.all.label, '全部模型');
  assert.equal(zhGuard.off.label, '关闭');
  assert.equal(enGuard.weak.label, 'Weak models only');
  assert.equal(enGuard.all.label, 'All models');
  assert.equal(enGuard.off.label, 'Off');
  assert.notEqual(zhGuard.weak.label, enGuard.weak.label);
  assert.match(zh.settingsEntries.agentLoop.fields.repeatGuard.label, /重复检测/);
  assert.match(en.settingsEntries.agentLoop.fields.repeatGuard.label, /Repeat detection/);
  assert.match(zh.settingsEntries.agentLoop.keywords, /重复检测/);
  assert.match(en.settingsEntries.agentLoop.keywords, /repeat detection/);
  assert.match(zh.play.stopReason.repeat_detection, /重复检测/);
  assert.match(en.play.stopReason.repeat_detection, /Repeat detection/);
  assert.equal(/[\u3400-\u9fff]/.test(en.play.stopReason.repeat_detection), false);
  assert.equal(/[\u3400-\u9fff]/.test(en.settingsEntries.agentLoop.fields.repeatGuard.hint), false);

  const card = readFileSync(join(here, '../../components/AgentLoopSettingsCard.tsx'), 'utf8');
  assert.match(card, /id="field-repeatGuard"/);
  assert.match(card, /repeatGuard: 'weak'/);
  const panel = readFileSync(join(here, '../../components/PlayPanel.tsx'), 'utf8');
  assert.match(panel, /repeat_detection: 'play\.stopReason\.repeat_detection'/);
});

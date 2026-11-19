import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_EFFORT_FOLLOW_GLOBAL,
  BOT_EFFORT_LEVELS,
  botEffortEffectiveText,
  botEffortFollowLabel,
  botEffortFromSelect,
  botEffortLevelLabel,
  botEffortSelectValue,
  parseBotThinkingEffort,
  readGlobalThinkingEffort
} from './bot-thinking-effort.ts';
import { readBotSettings } from './bot-policy.ts';
import { translate } from './i18n/t.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import type { MessageKey } from './i18n/messages/types.ts';

const tZh = (key: MessageKey, vars?: Record<string, string | number>) => translate(zh, key, vars, zh);
const tEn = (key: MessageKey, vars?: Record<string, string | number>) => translate(en, key, vars, zh);
const CJK = /[\u3400-\u9fff]/;

test('the pin is read from bot chat metadata, off included [AC:bot-thinking-effort#AC-1]', () => {
  for (const level of ['off', 'low', 'medium', 'high'] as const) {
    assert.equal(parseBotThinkingEffort({ thinkingEffort: level }), level);
    assert.equal(readBotSettings({ thinkingEffort: level }).thinkingEffort, level);
  }
  assert.equal(parseBotThinkingEffort(undefined), null);
  assert.equal(parseBotThinkingEffort({}), null);
  assert.equal(parseBotThinkingEffort({ thinkingEffort: 'turbo' }), null);
  assert.equal(readBotSettings(undefined).thinkingEffort, null);
});

test('the selector offers follow global plus off, low, medium and high and round-trips them [AC:bot-thinking-effort#AC-5]', () => {
  assert.deepEqual([...BOT_EFFORT_LEVELS], ['off', 'low', 'medium', 'high']);
  assert.equal(botEffortSelectValue(null), BOT_EFFORT_FOLLOW_GLOBAL);
  assert.equal(botEffortFromSelect(BOT_EFFORT_FOLLOW_GLOBAL), null);
  for (const level of BOT_EFFORT_LEVELS) {
    assert.equal(botEffortSelectValue(level), level);
    assert.equal(botEffortFromSelect(botEffortSelectValue(level)), level);
  }
  assert.equal(botEffortFromSelect('turbo'), null);
});

test('follow global names the current global level in zh and en [AC:bot-thinking-effort#AC-5]', () => {
  assert.equal(readGlobalThinkingEffort({ settings: { level: 'off' }, effective: { level: 'off', source: 'default' } }), 'off');
  assert.equal(readGlobalThinkingEffort({ settings: { level: 'high' } }), 'high');
  assert.equal(readGlobalThinkingEffort({ effective: { level: 'max' } }), null);
  assert.equal(readGlobalThinkingEffort(null), null);

  assert.equal(botEffortFollowLabel(tZh, 'off'), '跟随全局（当前：关闭）');
  assert.equal(botEffortFollowLabel(tEn, 'off'), 'Follow global (current: Off)');
  assert.equal(botEffortFollowLabel(tZh, 'high'), '跟随全局（当前：高）');
  assert.equal(botEffortFollowLabel(tZh, null), '跟随全局（默认）');
  assert.equal(botEffortFollowLabel(tEn, null), 'Follow global (default)');
  for (const level of BOT_EFFORT_LEVELS) {
    assert.equal(CJK.test(botEffortLevelLabel(tEn, level)), false);
    assert.equal(CJK.test(botEffortLevelLabel(tZh, level)), true);
  }
});

test('the card shows the level the next turn uses: pin first, else global [AC:bot-thinking-effort#AC-5]', () => {
  assert.equal(botEffortEffectiveText(tZh, 'low', 'high'), '当前生效：低（本 Bot 固定）');
  assert.equal(botEffortEffectiveText(tZh, 'off', 'high'), '当前生效：关闭（本 Bot 固定）');
  assert.equal(botEffortEffectiveText(tZh, null, 'medium'), '当前生效：中（跟随全局）');
  assert.equal(botEffortEffectiveText(tEn, 'low', 'high'), 'In effect: Low (pinned for this Bot)');
  assert.equal(botEffortEffectiveText(tEn, null, 'medium'), 'In effect: Medium (follows global)');
  assert.equal(CJK.test(botEffortEffectiveText(tEn, null, null)), false);
  assert.equal(CJK.test(botEffortEffectiveText(tZh, null, null)), true);
});

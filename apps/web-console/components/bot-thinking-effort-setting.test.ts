import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CJK = /[\u3400-\u9fff]/;

test('BotDetail offers a per-bot thinking effort selector next to the model pin [AC:bot-thinking-effort#AC-5]', () => {
  const detail = readFileSync(path.join(webRoot, 'components/sections/agents/BotDetail.tsx'), 'utf8');
  const card = readFileSync(path.join(webRoot, 'components/BotThinkingEffortSetting.tsx'), 'utf8');
  const modelAt = detail.indexOf('<BotModelSetting');
  const effortAt = detail.indexOf('<BotThinkingEffortSetting');
  const policyAt = detail.indexOf('<BotPolicySettings');
  assert.ok(modelAt > 0 && effortAt > modelAt && policyAt > effortAt);
  assert.match(detail, /pinned=\{settings\.thinkingEffort\}/);
  assert.match(detail, /onSave=\{saveThinkingEffort\}/);
  assert.match(detail, /patchBot\(\{ thinkingEffort: next \}\)/);
  assert.match(card, /\/api\/thinking-effort\/settings/);
  assert.match(card, /BOT_EFFORT_LEVELS\.map/);
  assert.match(card, /botEffortFollowLabel\(t, globalLevel\)/);
  assert.match(card, /botEffortEffectiveText\(t, pinned, globalLevel\)/);
  assert.match(card, /onSave\(botEffortFromSelect\(value\)\)/);
});

test('bot thinking effort copy exists in zh and en with the same keys [AC:bot-thinking-effort#AC-5]', () => {
  const zhCopy = zh.play.botEffort as Record<string, string>;
  const enCopy = en.play.botEffort as Record<string, string>;
  assert.deepEqual(Object.keys(enCopy).sort(), Object.keys(zhCopy).sort());
  for (const key of Object.keys(zhCopy)) {
    assert.equal(typeof zhCopy[key], 'string');
    assert.ok(zhCopy[key].length > 0);
    assert.equal(CJK.test(enCopy[key]), false, `en.play.botEffort.${key}`);
  }
  assert.match(zh.play.botEffort.title, /思考力度/);
  assert.match(en.play.botEffort.title, /thinking effort/i);
  assert.match(zh.play.botEffort.followGlobalWith, /\{level\}/);
  assert.match(en.play.botEffort.followGlobalWith, /\{level\}/);
});

test('the global thinking effort card is unchanged [AC:bot-thinking-effort#AC-6]', () => {
  const card = readFileSync(path.join(webRoot, 'components/ThinkingEffortSettingsCard.tsx'), 'utf8');
  assert.match(card, /const PATH = '\/api\/thinking-effort\/settings'/);
  assert.match(card, /r\.save\(\{ level: value \}\)/);
  for (const level of ['off', 'low', 'medium', 'high']) {
    assert.match(card, new RegExp(`'${level}'`));
    assert.equal(typeof zh.settingsEntries.thinkingEffort.options[level as 'off'].label, 'string');
    assert.equal(typeof en.settingsEntries.thinkingEffort.options[level as 'off'].label, 'string');
  }
});

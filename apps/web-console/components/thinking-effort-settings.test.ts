import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('behavior settings offer a thinking effort control [AC:thinking-effort#AC-2]', () => {
  const behavior = readFileSync(
    path.join(webRoot, 'components/sections/settings/categories/behavior.tsx'),
    'utf8'
  );
  const card = readFileSync(path.join(webRoot, 'components/ThinkingEffortSettingsCard.tsx'), 'utf8');
  assert.match(behavior, /id: 'thinkingEffort'/);
  assert.match(behavior, /ThinkingEffortSettingsCard/);
  assert.match(card, /\/api\/thinking-effort\/settings/);
  assert.match(card, /r\.save\(\{ level: value \}\)/);
  for (const level of ['off', 'low', 'medium', 'high']) {
    assert.match(card, new RegExp(`'${level}'`));
    assert.equal(typeof zh.settingsEntries.thinkingEffort.options[level].label, 'string');
    assert.equal(typeof en.settingsEntries.thinkingEffort.options[level].label, 'string');
  }
  assert.match(zh.settingsEntries.thinkingEffort.title, /思考力度/);
  assert.match(en.settingsEntries.thinkingEffort.title, /Thinking effort/);
  assert.equal(/[\u3400-\u9fff]/.test(en.settingsEntries.thinkingEffort.desc), false);
});

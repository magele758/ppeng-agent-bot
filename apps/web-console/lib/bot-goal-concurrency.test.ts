import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goalSettingFieldMax } from './bot-goals.ts';

test('goal concurrency field accepts more than 32 [AC:bot-extreme-concurrency#AC-5]', () => {
  assert.ok((goalSettingFieldMax('maxConcurrent') ?? 0) > 32);
  assert.equal(goalSettingFieldMax('maxAttempts'), undefined);
  const panel = readFileSync(new URL('../components/bot-work/BotGoals.tsx', import.meta.url), 'utf8');
  assert.match(panel, /goalSettingFieldMax\(key\)/);
});

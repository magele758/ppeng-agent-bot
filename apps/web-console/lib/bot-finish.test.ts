import assert from 'node:assert/strict';
import test from 'node:test';
import { BOT_FINISH_CHOICES, botFinishOptions } from './bot-finish.ts';

test('Lab offers the saved finish setting even when it is not a preset [AC:bot-finish-follow-through#AC-15]', () => {
  assert.deepEqual(botFinishOptions('maxContinuations', 2).map((option) => option.value), ['1', '2', '3', '5']);
  assert.deepEqual(botFinishOptions('maxContinuations', 4).map((option) => option.value), ['1', '2', '3', '4', '5']);
  assert.deepEqual(botFinishOptions('wakeDelayMinutes', 10).map((option) => option.value), BOT_FINISH_CHOICES.wakeDelayMinutes.map(String));
});

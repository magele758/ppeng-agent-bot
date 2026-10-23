import test from 'node:test';
import assert from 'node:assert/strict';
import { readBotSettings } from './bot-policy.ts';

test('missing or unlimited settings display unlimited, finite settings survive [AC:unlimited-execution-steps#AC-2]', () => {
  for (const metadata of [undefined, {}, { maxTurns: 0 }]) assert.equal(readBotSettings(metadata).maxTurns, 0);
  for (const maxTurns of [24, 48, 96]) assert.equal(readBotSettings({ maxTurns }).maxTurns, maxTurns);
});

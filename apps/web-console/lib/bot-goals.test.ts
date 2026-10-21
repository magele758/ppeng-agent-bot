import assert from 'node:assert/strict';
import test from 'node:test';
import { goalMessage, goalActions } from './bot-goals.ts';

test('explicit goal selection associates an interruption without replacing a command', () => {
  assert.equal(goalMessage('Keep the existing styles', 'g-login'), '[goal:g-login] Keep the existing styles');
  assert.equal(goalMessage('/status', 'g-login'), '/status');
  assert.equal(goalMessage('hello', null), 'hello');
  assert.equal(goalMessage('', 'g-login'), '');
});
test('completed and cancelled goals cannot accidentally be resumed from the panel', () => {
  assert.deepEqual(goalActions('cancelled'), []);
  assert.deepEqual(goalActions('completed'), []);
  assert.deepEqual(goalActions('paused'), ['resume', 'cancel']);
  assert.deepEqual(goalActions('waiting'), ['pause', 'cancel']);
});

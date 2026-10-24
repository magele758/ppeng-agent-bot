import assert from 'node:assert/strict';
import test from 'node:test';
import { goalMessage, goalActions, goalVerifyRequest } from './bot-goals.ts';

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
  assert.deepEqual(goalActions('pending_review'), ['verify', 'cancel']);
});
test('accept keeps accepted true; send-back posts accepted false and drops a blank reason', () => {
  assert.deepEqual(goalVerifyRequest(true), { action: 'verify', accepted: true });
  assert.deepEqual(goalVerifyRequest(false, '  还差最后一项核对  '), { action: 'verify', accepted: false, reason: '还差最后一项核对' });
  assert.deepEqual(goalVerifyRequest(false, '   '), { action: 'verify', accepted: false });
  assert.deepEqual(goalVerifyRequest(false), { action: 'verify', accepted: false });
});

test('terminal goal cards are archived instead of pinned [AC:unified-bot-goal-lifecycle#AC-3]', async () => {
 const { isLiveSessionGoal } = await import('./bot-goals.ts');
 for (const status of ['achieved','unmet_closed','completed','failed','cancelled']) assert.equal(isLiveSessionGoal(status),false);
 for (const status of ['active','waiting_user','queued','running','blocked','pending_review']) assert.equal(isLiveSessionGoal(status),true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuietGoalNotice } from '../dist/bots/goals/runtime-host.js';

test('formatQuietGoalNotice keeps short quiet completion copy [AC:quiet-goal-notice#AC-1]', () => {
  assert.equal(
    formatQuietGoalNotice({ id: 'g1', title: 'Ship polish', status: 'completed' }),
    '[goal update] Done: Ship polish'
  );
  assert.match(
    formatQuietGoalNotice({ id: 'g1', title: 'Ship polish', status: 'blocked', blockedReason: 'need key' }),
    /^\[goal update\] Blocked: Ship polish — need key$/
  );
  assert.match(
    formatQuietGoalNotice({ id: 'g1', title: 'Ship polish', status: 'pending_review' }),
    /^\[goal update\] Result returned \(not automatically verified\):/
  );
  assert.ok(
    !formatQuietGoalNotice({
      id: 'g1',
      title: 'Ship polish',
      status: 'completed',
      progress: 1,
      nextStep: 'x',
    }).includes('{')
  );
});

test('unverified result stays quiet without changing stored state [AC:quiet-goal-results#AC-3]', async () => {
  const { announceGoalState } = await import('../dist/bots/goals/runtime-host.js');
  const notices = [];
  const store = {
    transaction: fn => fn(),
    getDaemonControl: () => undefined,
    setDaemonControl() {},
    appendMessage: (...args) => notices.push(args)
  };
  const goal = { id: 'g1', botId: 'b', sessionId: 's', status: 'pending_review', evidence: ['result'] };
  announceGoalState({ store }, goal);
  assert.deepEqual(notices, []);
  assert.equal(goal.status, 'pending_review');
  assert.deepEqual(goal.evidence, ['result']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuietGoalNotice } from '../dist/bots/goals/runtime-host.js';

test('formatQuietGoalNotice keeps short quiet completion copy', () => {
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
    /^\[goal update\] Needs review:/
  );
});

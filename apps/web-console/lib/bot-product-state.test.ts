import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotActivityItems } from './bot-activity.ts';
import { routineStatusPresentation } from './routine-status.ts';

test('activity retains failed and cancelled outcomes instead of presenting success [AC:bot-product-p0#AC-2]', () => {
  const items = parseBotActivityItems({ items: ['failed', 'cancelled', 'unknown', 'waiting_approval'].map(outcomeStatus => ({
    id: outcomeStatus, title: outcomeStatus, status: outcomeStatus === 'failed' || outcomeStatus === 'cancelled' ? 'done' : 'waiting',
    outcomeStatus, startedAt: '2026-10-20T00:00:00Z',
  })) });
  assert.deepEqual(items.map(item => item.outcomeStatus), ['failed', 'cancelled', 'unknown', 'waiting_approval']);
  assert.equal(routineStatusPresentation('done').status, 'unknown', 'a legacy end marker is not proof of success');
  assert.equal(routineStatusPresentation('error').status, 'failed', 'background process errors use the same failure label');
  assert.equal(routineStatusPresentation('pending').status, 'queued');
});

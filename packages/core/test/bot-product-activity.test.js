import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleBotActivity } from '../dist/bots/bot-activity.js';

test('activity exposes real outcome independently of the compatible lifecycle bucket [AC:bot-product-p0#AC-2]', () => {
  const now = '2026-10-20T00:00:00.000Z';
  const focus = { id: 'chat', agentId: 'bot', metadata: { botId: 'bot', userId: 'user' } };
  const items = assembleBotActivity({
    focus, sessions: [], routines: [], botNames: new Map(),
    jobs: ['completed', 'failed', 'cancelled'].map(status => ({
      id: status, sessionId: 'chat', command: 'work', status, createdAt: now, updatedAt: now,
    })), now: Date.parse(now),
  });
  assert.deepEqual(items.map(item => [item.id, item.status, item.outcomeStatus]).sort(), [
    ['job:cancelled', 'done', 'cancelled'],
    ['job:completed', 'done', 'completed'],
    ['job:failed', 'done', 'failed'],
  ]);
});

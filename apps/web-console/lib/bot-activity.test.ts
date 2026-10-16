import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBotActivityItems } from './bot-activity.ts';

test('activity list keeps running, waiting, and done rows', () => {
  const items = parseBotActivityItems({
    items: [
      { id: 'a', title: 'Digest', status: 'running', botId: 'ada', botName: 'Ada', startedAt: '2026-10-16T11:01:00.000Z' },
      { id: 'b', title: 'Sweep', status: 'waiting', botId: 'ada', botName: 'Ada', startedAt: '2026-10-16T11:10:00.000Z' },
      { id: 'c', title: 'Done job', status: 'done', botName: 'Ada', startedAt: '2026-10-16T11:50:00.000Z' },
      { id: 'skip', title: 'Nope', status: 'exploded', startedAt: '2026-10-16T11:50:00.000Z' },
      null
    ]
  });
  assert.deepEqual(
    items.map((item) => [item.id, item.status, item.botName, item.startedAt]),
    [
      ['a', 'running', 'Ada', '2026-10-16T11:01:00.000Z'],
      ['b', 'waiting', 'Ada', '2026-10-16T11:10:00.000Z'],
      ['c', 'done', 'Ada', '2026-10-16T11:50:00.000Z']
    ]
  );
  assert.equal(parseBotActivityItems(null).length, 0);
  assert.equal(parseBotActivityItems({ items: 'nope' }).length, 0);
});

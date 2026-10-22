import test from 'node:test';
import assert from 'node:assert/strict';
import { activityOpenSessionId, openBotActivitySession, parseBotActivityItems } from './bot-activity.ts';

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

test('activity rows keep only a real session id [AC:bot-activity-open-session#AC-1] [AC:bot-activity-open-session#AC-2]', () => {
  const items = parseBotActivityItems({
    items: [
      {
        id: 'job:bg',
        title: 'cd /tmp && grok --prompt-file plan.md',
        status: 'done',
        botName: 'Ada',
        startedAt: '2026-10-16T11:50:00.000Z',
        sessionId: ' child-grok '
      },
      {
        id: 'session:child-grok',
        title: 'Guessed from the activity id',
        status: 'running',
        startedAt: '2026-10-16T11:20:00.000Z'
      },
      {
        id: 'routine:queued',
        title: 'Not started',
        status: 'waiting',
        startedAt: '2026-10-16T11:10:00.000Z',
        sessionId: '   '
      },
      {
        id: 'job:bad',
        title: 'Bad session',
        status: 'done',
        startedAt: '2026-10-16T11:10:00.000Z',
        sessionId: 12
      }
    ]
  });
  assert.equal(items[0]?.sessionId, 'child-grok');
  assert.equal(items[1]?.sessionId, undefined);
  assert.equal(Object.hasOwn(items[1] ?? {}, 'sessionId'), false);
  assert.equal(activityOpenSessionId({ id: 'session:child-grok' } as { sessionId?: string }), undefined);
  assert.equal(items[2]?.sessionId, undefined);
  assert.equal(items[3]?.sessionId, undefined);

  const opened: Array<[string, { focusChat?: boolean } | undefined]> = [];
  assert.equal(
    openBotActivitySession((id, opts) => opened.push([id, opts]), { sessionId: 'child-grok', id: 'job:bg' } as { sessionId?: string }),
    true
  );
  assert.deepEqual(opened, [['child-grok', { focusChat: true }]]);
  assert.notEqual(opened[0]?.[0], 'focus');
  assert.notEqual(opened[0]?.[0], 'job:bg');

  const missed: string[] = [];
  assert.equal(openBotActivitySession((id) => missed.push(id), { sessionId: '   ' }), false);
  assert.equal(openBotActivitySession((id) => missed.push(id), {}), false);
  assert.equal(openBotActivitySession((id) => missed.push(id), { sessionId: 'session:child-grok' }), true);
  assert.deepEqual(missed, ['session:child-grok']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  metricForTurn,
  toSentRequestMetrics,
  type SentRequestMetric,
  type SentRequestSource
} from './request-metric-turn.ts';

function percent(estimatedTokens: number, windowTokens: number): number {
  return Number(((estimatedTokens / windowTokens) * 100).toFixed(1));
}

function ready(result: ReturnType<typeof metricForTurn>): { metric: SentRequestMetric; isLatest: boolean } {
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('waiting');
  return result;
}

function threeTurns(): SentRequestSource {
  return {
    sessionId: 'chat',
    snapshots: [
      {
        turn: 3,
        createdAt: '2026-10-21T03:00:00.000Z',
        sentAt: '2026-10-21T03:00:00.000Z',
        estimatedTokens: 3300,
        windowTokens: 10000,
        actualInputTokens: 30,
        blocks: [{ tokens: 999999 }]
      },
      {
        turn: 1,
        createdAt: '2026-10-21T01:00:00.000Z',
        sentAt: '2026-10-21T01:00:00.000Z',
        estimatedTokens: 1100,
        windowTokens: 10000,
        actualInputTokens: 10,
        blocks: [{ tokens: 1 }]
      },
      {
        turn: 2,
        createdAt: '2026-10-21T02:00:00.000Z',
        sentAt: '2026-10-21T02:00:00.000Z',
        estimatedTokens: 2200,
        windowTokens: 8000,
        actualInputTokens: 20,
        blocks: [{ tokens: 50 }]
      }
    ],
    latestRequest: {
      sessionId: 'chat',
      sentAt: '2026-10-21T03:00:00.000Z',
      estimatedTokens: 3300,
      windowTokens: 10000,
      actualInputTokens: 30
    }
  };
}

test('选较早两轮时 token 各是该轮的 [AC:request-metric-follows-turn#AC-1]', () => {
  const sent = toSentRequestMetrics(threeTurns());
  assert.ok(sent.length >= 3);
  const tokens = new Set(sent.map((item) => item.estimatedTokens));
  assert.equal(tokens.size, sent.length);

  const first = ready(metricForTurn({ sent, selectedTurnNumber: 1 }));
  const second = ready(metricForTurn({ sent, selectedTurnNumber: 2 }));
  assert.equal(first.isLatest, false);
  assert.equal(second.isLatest, false);
  assert.equal(first.metric.turnNumber, 1);
  assert.equal(second.metric.turnNumber, 2);
  assert.equal(first.metric.estimatedTokens, 1100);
  assert.equal(second.metric.estimatedTokens, 2200);
  assert.notEqual(first.metric.estimatedTokens, 3300);
  assert.notEqual(second.metric.estimatedTokens, 3300);
  assert.notEqual(first.metric.estimatedTokens, second.metric.estimatedTokens);
  assert.notEqual(first.metric.estimatedTokens, 1);
  assert.notEqual(second.metric.estimatedTokens, 50);
});

test('选中一轮时占比、上游用量和发送时间都属于这一轮 [AC:request-metric-follows-turn#AC-2]', () => {
  const sent = toSentRequestMetrics({
    sessionId: 'chat',
    snapshots: [
      {
        turn: 1,
        createdAt: '2026-10-21T01:10:00.000Z',
        sentAt: '2026-10-21T01:11:00.000Z',
        estimatedTokens: 627,
        windowTokens: 1000,
        actualInputTokens: 15
      },
      {
        turn: 2,
        createdAt: '2026-10-21T02:10:00.000Z',
        sentAt: '2026-10-21T02:11:00.000Z',
        estimatedTokens: 800,
        windowTokens: 1000,
        actualInputTokens: 90
      }
    ],
    latestRequest: {
      sessionId: 'chat',
      sentAt: '2026-10-21T02:11:00.000Z',
      estimatedTokens: 800,
      windowTokens: 1000,
      actualInputTokens: 90
    }
  });
  const picked = ready(metricForTurn({ sent, selectedTurnNumber: 1 }));
  assert.equal(picked.isLatest, false);
  assert.equal(picked.metric.turnNumber, 1);
  assert.equal(picked.metric.estimatedTokens, 627);
  assert.equal(picked.metric.windowPercent, percent(627, 1000));
  assert.equal(picked.metric.windowPercent, 62.7);
  assert.equal(picked.metric.upstreamInputTokens, 15);
  assert.equal(picked.metric.sentAtLabel, '2026-10-21T01:11:00.000Z');
  assert.notEqual(picked.metric.windowPercent, percent(800, 1000));
  assert.notEqual(picked.metric.upstreamInputTokens, 90);
  assert.notEqual(picked.metric.sentAtLabel, '2026-10-21T02:11:00.000Z');
  assert.notEqual(picked.metric.sentAtLabel, '2026-10-21T01:10:00.000Z');
});

test('滑块在当前最新时用最近一次已发送请求 [AC:request-metric-follows-turn#AC-3]', () => {
  const sent = toSentRequestMetrics(threeTurns());
  const reversed = [...sent].reverse();
  const live = ready(metricForTurn({ sent: reversed, selectedTurnNumber: null }));
  const lastTurn = ready(metricForTurn({ sent: reversed, selectedTurnNumber: live.metric.turnNumber }));
  assert.equal(live.isLatest, true);
  assert.equal(lastTurn.isLatest, true);
  assert.equal(live.metric.turnNumber, 3);
  assert.deepEqual(live.metric, lastTurn.metric);
  assert.equal(live.metric.estimatedTokens, 3300);
  assert.equal(live.metric.windowPercent, percent(3300, 10000));
  assert.equal(live.metric.upstreamInputTokens, 30);
  assert.equal(live.metric.sentAtLabel, '2026-10-21T03:00:00.000Z');
  assert.notEqual(live.metric.estimatedTokens, 1100);
  assert.notEqual(live.metric.estimatedTokens, 2200);
});

test('没有上游用量的那一轮保持未知 [AC:request-metric-follows-turn#AC-4]', () => {
  const sent = toSentRequestMetrics({
    sessionId: 'chat',
    snapshots: [
      {
        turn: 1,
        createdAt: '2026-10-21T01:00:00.000Z',
        sentAt: '2026-10-21T01:00:00.000Z',
        estimatedTokens: 5200,
        windowTokens: 20000,
        actualInputTokens: null
      },
      {
        turn: 2,
        createdAt: '2026-10-21T02:00:00.000Z',
        sentAt: '2026-10-21T02:00:00.000Z',
        estimatedTokens: 4100,
        windowTokens: 10000,
        actualInputTokens: 41
      }
    ],
    latestRequest: {
      sessionId: 'chat',
      sentAt: '2026-10-21T02:00:00.000Z',
      estimatedTokens: 4100,
      windowTokens: 10000,
      actualInputTokens: 41
    }
  });
  const missing = ready(metricForTurn({ sent, selectedTurnNumber: 1 }));
  assert.equal(missing.isLatest, false);
  assert.equal(missing.metric.turnNumber, 1);
  assert.equal(missing.metric.upstreamInputTokens, null);
  assert.equal(missing.metric.estimatedTokens, 5200);
  assert.equal(missing.metric.windowPercent, percent(5200, 20000));
  assert.equal(missing.metric.sentAtLabel, '2026-10-21T01:00:00.000Z');
  assert.notEqual(missing.metric.upstreamInputTokens, 41);
  assert.notEqual(missing.metric.estimatedTokens, 4100);
});

test('重复查询选中轮不会变回最近一次 [AC:request-metric-follows-turn#AC-5]', () => {
  const source = threeTurns();
  const before = structuredClone(source);
  const sent = toSentRequestMetrics(source);
  assert.deepEqual(source, before);
  const again = toSentRequestMetrics(source);
  assert.deepEqual(again, sent);

  const first = metricForTurn({ sent, selectedTurnNumber: 2 });
  metricForTurn({ sent, selectedTurnNumber: null });
  const second = metricForTurn({ sent, selectedTurnNumber: 2 });
  const third = metricForTurn({ sent, selectedTurnNumber: 2 });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  const picked = ready(first);
  assert.equal(picked.isLatest, false);
  assert.equal(picked.metric.turnNumber, 2);
  assert.equal(picked.metric.estimatedTokens, 2200);
  assert.equal(picked.metric.windowPercent, percent(2200, 8000));
  assert.equal(picked.metric.upstreamInputTokens, 20);
  assert.equal(picked.metric.sentAtLabel, '2026-10-21T02:00:00.000Z');
  assert.notEqual(picked.metric.estimatedTokens, 3300);
  assert.deepEqual(sent.map((item) => item.estimatedTokens), [1100, 2200, 3300]);
});

test('只有一轮时选该轮或最新都是这一轮 [AC:request-metric-follows-turn#AC-6]', () => {
  const current = toSentRequestMetrics({
    sessionId: 'current',
    snapshots: [
      {
        turn: 1,
        createdAt: '2026-04-01T00:00:00.000Z',
        sentAt: '2026-04-01T00:00:00.000Z',
        estimatedTokens: 42,
        windowTokens: 100,
        actualInputTokens: 3
      }
    ],
    requests: [
      {
        sessionId: 'other',
        turn: 1,
        estimatedTokens: 99999,
        windowTokens: 10,
        actualInputTokens: 8,
        sentAt: '1999-01-01T00:00:00.000Z'
      }
    ],
    latestRequest: {
      sessionId: 'other',
      estimatedTokens: 99999,
      windowTokens: 10,
      actualInputTokens: 8,
      sentAt: '1999-01-01T00:00:00.000Z'
    }
  });
  const other = toSentRequestMetrics({
    sessionId: 'other',
    latestRequest: {
      sessionId: 'other',
      estimatedTokens: 99999,
      windowTokens: 10,
      actualInputTokens: 8,
      sentAt: '1999-01-01T00:00:00.000Z'
    }
  });
  assert.equal(other[0]?.estimatedTokens, 99999);
  assert.equal(current.length, 1);

  const byTurn = ready(metricForTurn({ sent: current, selectedTurnNumber: 1 }));
  const byLive = ready(metricForTurn({ sent: current, selectedTurnNumber: null }));
  assert.equal(byTurn.isLatest, true);
  assert.equal(byLive.isLatest, true);
  assert.deepEqual(byTurn.metric, byLive.metric);
  assert.equal(byTurn.metric.estimatedTokens, 42);
  assert.equal(byTurn.metric.windowPercent, percent(42, 100));
  assert.equal(byTurn.metric.upstreamInputTokens, 3);
  assert.equal(byTurn.metric.sentAtLabel, '2026-04-01T00:00:00.000Z');
  assert.equal(JSON.stringify(byTurn).includes('99999'), false);
  assert.equal(JSON.stringify(byLive).includes('1999-01-01'), false);

  const outside = metricForTurn({ sent: current, selectedTurnNumber: 50 });
  assert.deepEqual(outside, { status: 'waiting' });
  assert.equal(JSON.stringify(outside).includes('99999'), false);
  assert.equal(JSON.stringify(outside).includes('42'), false);
});

test('没有已发送请求时等待，不编造 token 或发送时间 [AC:request-metric-follows-turn#AC-7]', () => {
  const other = toSentRequestMetrics({
    sessionId: 'other',
    latestRequest: {
      sessionId: 'other',
      estimatedTokens: 99999,
      windowTokens: 10,
      actualInputTokens: 8,
      sentAt: '1999-01-01T00:00:00.000Z'
    }
  });
  assert.equal(other[0]?.estimatedTokens, 99999);

  const empty = toSentRequestMetrics({
    sessionId: 'current',
    snapshots: [
      { turn: 1, createdAt: '2026-05-01T00:00:00.000Z', blocks: [{ tokens: 777 }] }
    ],
    latestRequest: {
      sessionId: 'other',
      estimatedTokens: 99999,
      windowTokens: 10,
      actualInputTokens: 8,
      sentAt: '1999-01-01T00:00:00.000Z'
    },
    requests: []
  });
  assert.deepEqual(empty, []);
  assert.deepEqual(toSentRequestMetrics({ sessionId: 'current', snapshots: [], latestRequest: null }), []);

  const waiting = metricForTurn({ sent: empty, selectedTurnNumber: null });
  assert.deepEqual(waiting, { status: 'waiting' });
  assert.equal('metric' in waiting, false);
  assert.equal(JSON.stringify(waiting).includes('99999'), false);
  assert.equal(JSON.stringify(waiting).includes('1999-01-01'), false);
  assert.equal(JSON.stringify(waiting).includes('777'), false);
  assert.equal(JSON.stringify(waiting).includes('2026-05-01'), false);
});

test('接口里的 latestRequest 对到最大的快照轮次，不用上下文色块 token', () => {
  const sent = toSentRequestMetrics({
    sessionId: 's',
    snapshots: [
      { turn: 2, createdAt: '2026-10-21T02:00:00.000Z', blocks: [{ tokens: 9 }] },
      { turn: 1, createdAt: '2026-10-21T01:00:00.000Z', blocks: [{ tokens: 8 }] },
      { turn: 3, createdAt: '2026-10-21T03:00:00.000Z', blocks: [{ tokens: 7 }] }
    ],
    latestRequest: {
      sessionId: 's',
      sentAt: '2026-10-21T03:00:05.000Z',
      estimatedTokens: 42000,
      windowTokens: 131072
    }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.turnNumber, 3);
  assert.equal(sent[0]?.estimatedTokens, 42000);
  assert.equal(sent[0]?.windowPercent, 32);
  assert.equal(sent[0]?.upstreamInputTokens, null);
  assert.equal(sent[0]?.sentAtLabel, '2026-10-21T03:00:05.000Z');
  const live = ready(metricForTurn({ sent, selectedTurnNumber: null }));
  const atTurn = ready(metricForTurn({ sent, selectedTurnNumber: 3 }));
  assert.equal(live.isLatest, true);
  assert.equal(atTurn.isLatest, true);
  assert.deepEqual(live.metric, atTurn.metric);
  assert.equal(metricForTurn({ sent, selectedTurnNumber: 1 }).status, 'waiting');
});

test('别的会话的快照轮次不会把当前请求挪走', () => {
  const sent = toSentRequestMetrics({
    sessionId: 'current',
    snapshots: [
      { sessionId: 'other', turn: 9, createdAt: 'x' },
      { sessionId: 'current', turn: 1, createdAt: 'y' }
    ],
    latestRequest: { sessionId: 'current', estimatedTokens: 42, windowTokens: 100, sentAt: 'z' }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.turnNumber, 1);
  assert.equal(sent[0]?.estimatedTokens, 42);
});

test('最近一次的时间撞上更早轮时不改写那一轮', () => {
  const sent = toSentRequestMetrics({
    snapshots: [
      {
        turn: 1,
        createdAt: 'same',
        sentAt: 'same',
        estimatedTokens: 100,
        windowTokens: 1000,
        actualInputTokens: null
      },
      {
        turn: 2,
        createdAt: 'later',
        sentAt: 'later',
        estimatedTokens: 200,
        windowTokens: 1000,
        actualInputTokens: 4
      }
    ],
    latestRequest: { estimatedTokens: 300, windowTokens: 1000, sentAt: 'same', actualInputTokens: 9 }
  });
  assert.equal(sent.find((item) => item.turnNumber === 1)?.estimatedTokens, 100);
  assert.equal(sent.find((item) => item.turnNumber === 1)?.upstreamInputTokens, null);
  assert.equal(sent.find((item) => item.turnNumber === 2)?.estimatedTokens, 200);
  assert.equal(sent.find((item) => item.turnNumber === 2)?.upstreamInputTokens, 4);
  assert.equal(sent.find((item) => item.turnNumber === 3)?.estimatedTokens, 300);
  assert.equal(sent.find((item) => item.turnNumber === 3)?.upstreamInputTokens, 9);
});

test('更新的最近一次请求不会覆盖更早轮的数字', () => {
  const sent = toSentRequestMetrics({
    snapshots: [
      {
        turn: 1,
        createdAt: 't1',
        sentAt: 't1',
        estimatedTokens: 100,
        windowTokens: 1000,
        actualInputTokens: null
      },
      {
        turn: 2,
        createdAt: 't2',
        sentAt: 't2',
        estimatedTokens: 200,
        windowTokens: 1000,
        actualInputTokens: 0
      }
    ],
    latestRequest: {
      estimatedTokens: 300,
      windowTokens: 1500,
      sentAt: 't3',
      actualInputTokens: 9
    }
  });
  assert.deepEqual(sent.map((item) => item.turnNumber), [1, 2, 3]);
  assert.equal(sent[0]?.estimatedTokens, 100);
  assert.equal(sent[0]?.upstreamInputTokens, null);
  assert.equal(sent[1]?.estimatedTokens, 200);
  assert.equal(sent[1]?.upstreamInputTokens, 0);
  assert.equal(sent[2]?.estimatedTokens, 300);
  assert.equal(sent[2]?.upstreamInputTokens, 9);
  assert.equal(sent[2]?.windowPercent, percent(300, 1500));
  assert.equal(sent[2]?.sentAtLabel, 't3');
});

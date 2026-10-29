import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnFeedStats,
  extractModelTurnWindows,
  formatTurnFeedStatsLine,
  sliceConversationTurns
} from './turn-feed-stats.ts';

test('sliceConversationTurns groups user→assistant(+tools) cycles', () => {
  const slices = sliceConversationTurns([
    { role: 'system', createdAt: '2026-09-03T12:00:00.000Z' },
    { role: 'user', createdAt: '2026-09-03T12:00:01.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:02.000Z' },
    { role: 'tool', createdAt: '2026-09-03T12:00:03.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:04.000Z' },
    { role: 'user', createdAt: '2026-09-03T12:01:00.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:01:05.000Z' }
  ]);
  assert.deepEqual(slices, [
    { userIndex: 1, startIndex: 1, endIndex: 4 },
    { userIndex: 5, startIndex: 5, endIndex: 6 }
  ]);
});

test('extractModelTurnWindows pairs start/end and reads usage', () => {
  const windows = extractModelTurnWindows([
    { kind: 'turn_start', ts: '2026-09-03T12:00:01.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:05.000Z',
      payload: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, costUsd: 0.01 }
    },
    { kind: 'turn_start', ts: '2026-09-03T12:00:06.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:10.000Z',
      payload: { usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 }, costUsd: 0.02 }
    }
  ]);
  assert.equal(windows.length, 2);
  assert.equal(windows[0]!.usage?.inputTokens, 100);
  assert.equal(windows[1]!.costUsd, 0.02);
});

test('buildTurnFeedStats sums model turns inside one user cycle', () => {
  const messages = [
    { role: 'user', createdAt: '2026-09-03T12:00:00.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:05.000Z' },
    { role: 'tool', createdAt: '2026-09-03T12:00:06.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:10.000Z' },
    { role: 'user', createdAt: '2026-09-03T12:01:00.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:01:03.000Z' }
  ];
  const traces = [
    { kind: 'turn_start', ts: '2026-09-03T12:00:01.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:05.000Z',
      payload: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, costUsd: 0.01 }
    },
    { kind: 'turn_start', ts: '2026-09-03T12:00:06.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:10.000Z',
      payload: { usage: { inputTokens: 2000, outputTokens: 50, totalTokens: 2050 }, costUsd: 0.02 }
    },
    { kind: 'turn_start', ts: '2026-09-03T12:01:01.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:01:03.000Z',
      payload: { usage: { inputTokens: 500, outputTokens: 40, totalTokens: 540 }, costUsd: 0.005 }
    }
  ];
  const stats = buildTurnFeedStats({ messages, traces });
  assert.equal(stats.length, 2);
  assert.deepEqual(stats[0]?.usageTotals, {
    inputTokens: 3000,
    outputTokens: 150,
    totalTokens: 3150
  });
  assert.equal(stats[0]?.usageCostUsd, 0.03);
  assert.equal(stats[0]?.elapsedMs, 9_000);
  assert.deepEqual(stats[1]?.usageTotals, {
    inputTokens: 500,
    outputTokens: 40,
    totalTokens: 540
  });
  assert.equal(stats[1]?.elapsedMs, 2_000);
});

test('buildTurnFeedStats falls back to message timestamps without traces', () => {
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-09-03T12:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-09-03T12:00:40.000Z' }
    ]
  });
  assert.equal(stats[0]?.elapsedMs, 40_000);
  assert.equal(stats[0]?.usageTotals, undefined);
});

test('buildTurnFeedStats returns null when a turn has no timing or usage', () => {
  const stats = buildTurnFeedStats({
    messages: [{ role: 'user' }, { role: 'assistant' }]
  });
  assert.equal(stats[0], null);
});

test('buildTurnFeedStats live tail extends elapsed to now', () => {
  const now = Date.parse('2026-09-03T12:00:30.000Z');
  const stats = buildTurnFeedStats({
    messages: [{ role: 'user', createdAt: '2026-09-03T12:00:00.000Z' }],
    traces: [{ kind: 'turn_start', ts: '2026-09-03T12:00:01.000Z' }],
    running: true,
    now
  });
  assert.equal(stats[0]?.elapsedMs, 29_000);
});

test('formatTurnFeedStatsLine reuses feed footer formatting', () => {
  assert.equal(
    formatTurnFeedStatsLine({
      elapsedMs: 83_000,
      usageTotals: { inputTokens: 12_400, outputTokens: 3_100 },
      usageCostUsd: 0.012
    }),
    '执行 1m 23s · 输入 12.4k · 输出 3.1k · $0.012'
  );
  assert.equal(formatTurnFeedStatsLine(null), null);
});

const endTimeLabels = {
  elapsed: '执行',
  input: '输入',
  output: '输出',
  ended: '结束',
  sessionEnded: '会话结束'
};

function expectedEndClock(ms: number, locale: 'zh' | 'en'): string {
  const tag = locale === 'zh' ? 'zh-CN' : 'en';
  return new Intl.DateTimeFormat(tag, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(ms);
}

test('finished turn stats keep usage and add a local end time [AC:turn-stats-end-time#AC-1]', () => {
  const endedAt = Date.parse('2026-10-22T08:47:00.000Z');
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-22T08:46:56.000Z' },
      { role: 'assistant', createdAt: '2026-10-22T08:47:00.000Z' }
    ],
    traces: [
      { kind: 'turn_start', ts: '2026-10-22T08:46:56.000Z' },
      {
        kind: 'turn_end',
        ts: '2026-10-22T08:47:00.000Z',
        payload: { usage: { inputTokens: 20_500, outputTokens: 275, totalTokens: 20_775 }, costUsd: 0.05 }
      }
    ]
  });
  assert.equal(stats[0]?.endedAtMs, endedAt);
  assert.equal(stats[0]?.sessionEnded, true);
  const line = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh');
  assert.equal(
    line,
    `执行 4s · 输入 20.5k · 输出 275 · $0.050 · 会话结束 ${expectedEndClock(endedAt, 'zh')}`
  );
  const english = formatTurnFeedStatsLine(
    stats[0],
    { elapsed: 'Ran', input: 'In', output: 'Out', ended: 'Ended', sessionEnded: 'Session ended' },
    'en'
  );
  assert.equal(
    english,
    `Ran 4s · In 20.5k · Out 275 · $0.050 · Session ended ${expectedEndClock(endedAt, 'en')}`
  );
});

test('finished turn without traces uses the reply time [AC:turn-stats-end-time#AC-1]', () => {
  const endedAt = Date.parse('2026-09-03T12:00:40.000Z');
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-09-03T12:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-09-03T12:00:40.000Z' }
    ]
  });
  assert.equal(stats[0]?.endedAtMs, endedAt);
  assert.equal(stats[0]?.elapsedMs, 40_000);
  const line = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh') ?? '';
  assert.match(line, /^执行 40s · 会话结束 /);
  assert.ok(line.endsWith(expectedEndClock(endedAt, 'zh')));
});

test('a running turn does not invent an end time [AC:turn-stats-end-time#AC-2]', () => {
  const now = Date.parse('2026-10-22T08:47:30.000Z');
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-22T08:46:56.000Z' },
      { role: 'assistant', createdAt: '2026-10-22T08:47:00.000Z' }
    ],
    traces: [
      { kind: 'turn_start', ts: '2026-10-22T08:46:56.000Z' },
      {
        kind: 'turn_end',
        ts: '2026-10-22T08:47:00.000Z',
        payload: { usage: { inputTokens: 20_500, outputTokens: 275 }, costUsd: 0.05 }
      },
      { kind: 'turn_start', ts: '2026-10-22T08:47:01.000Z' }
    ],
    running: true,
    now
  });
  assert.equal(stats[0]?.endedAtMs, undefined);
  assert.notEqual(stats[0]?.sessionEnded, true);
  const line = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh') ?? '';
  assert.match(line, /执行 /);
  assert.match(line, /输入 20\.5k/);
  assert.match(line, /输出 275/);
  assert.match(line, /\$0\.050/);
  assert.doesNotMatch(line, /结束/);
  assert.equal(line.includes(expectedEndClock(now, 'zh')), false);
});

test('waiting on the user does not show a session end time [AC:turn-stats-end-time#AC-2]', () => {
  const endedAt = Date.parse('2026-10-22T08:47:00.000Z');
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-22T08:46:56.000Z' },
      { role: 'assistant', createdAt: '2026-10-22T08:47:00.000Z' }
    ],
    traces: [
      { kind: 'turn_start', ts: '2026-10-22T08:46:56.000Z' },
      {
        kind: 'turn_end',
        ts: '2026-10-22T08:47:00.000Z',
        payload: { usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.02 }
      }
    ],
    sessionOpen: true
  });
  assert.equal(stats[0]?.endedAtMs, undefined);
  assert.notEqual(stats[0]?.sessionEnded, true);
  const line = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh') ?? '';
  assert.match(line, /执行 /);
  assert.doesNotMatch(line, /结束/);
  assert.equal(line.includes(expectedEndClock(endedAt, 'zh')), false);
});

test('earlier turns show their own end and the last turn shows when the session ended [AC:turn-stats-end-time#AC-3]', () => {
  const firstEnd = Date.parse('2026-09-03T12:00:10.000Z');
  const sessionEnd = Date.parse('2026-09-03T12:01:03.000Z');
  const messages = [
    { role: 'user', createdAt: '2026-09-03T12:00:00.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:05.000Z' },
    { role: 'tool', createdAt: '2026-09-03T12:00:06.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:00:10.000Z' },
    { role: 'user', createdAt: '2026-09-03T12:01:00.000Z' },
    { role: 'assistant', createdAt: '2026-09-03T12:01:03.000Z' }
  ];
  const traces = [
    { kind: 'turn_start', ts: '2026-09-03T12:00:01.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:05.000Z',
      payload: { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, costUsd: 0.01 }
    },
    { kind: 'turn_start', ts: '2026-09-03T12:00:06.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:00:10.000Z',
      payload: { usage: { inputTokens: 2000, outputTokens: 50, totalTokens: 2050 }, costUsd: 0.02 }
    },
    { kind: 'turn_start', ts: '2026-09-03T12:01:01.000Z' },
    {
      kind: 'turn_end',
      ts: '2026-09-03T12:01:03.000Z',
      payload: { usage: { inputTokens: 500, outputTokens: 40, totalTokens: 540 }, costUsd: 0.005 }
    }
  ];
  const stats = buildTurnFeedStats({ messages, traces });
  assert.equal(stats[0]?.endedAtMs, firstEnd);
  assert.notEqual(stats[0]?.sessionEnded, true);
  assert.equal(stats[1]?.endedAtMs, sessionEnd);
  assert.equal(stats[1]?.sessionEnded, true);
  const earlier = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh') ?? '';
  const last = formatTurnFeedStatsLine(stats[1], endTimeLabels, 'zh') ?? '';
  assert.match(earlier, /执行 9s · 输入 3k · 输出 150 · \$0\.030 · 结束 /);
  assert.doesNotMatch(earlier, /会话结束/);
  assert.ok(earlier.endsWith(expectedEndClock(firstEnd, 'zh')));
  assert.match(last, /执行 2s · 输入 500 · 输出 40 · \$0\.0050 · 会话结束 /);
  assert.ok(last.endsWith(expectedEndClock(sessionEnd, 'zh')));
  assert.notEqual(expectedEndClock(firstEnd, 'zh'), expectedEndClock(sessionEnd, 'zh'));
});

test('a turn with no end timestamp does not show an end time [AC:turn-stats-end-time#AC-4]', () => {
  const stats = buildTurnFeedStats({
    messages: [{ role: 'user', createdAt: '2026-09-03T12:00:00.000Z' }]
  });
  assert.equal(stats[0]?.endedAtMs, undefined);
  assert.equal(formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh'), null);

  const blank = buildTurnFeedStats({
    messages: [{ role: 'user' }, { role: 'assistant' }]
  });
  assert.equal(blank[0], null);
  assert.equal(formatTurnFeedStatsLine(blank[0], endTimeLabels, 'zh'), null);
});

const SECRET = 'PLANTED_STARTUP_BODY_not_for_the_footer';

test('turn footer shows startup total, slowest phase, and other slices without message text [AC:lab-startup-timing#AC-1] [AC:lab-startup-timing#AC-2]', () => {
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-28T01:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-10-28T01:00:04.000Z' }
    ],
    traces: [
      { kind: 'turn_start', ts: '2026-10-28T01:00:01.000Z' },
      {
        kind: 'startup_phase',
        ts: '2026-10-28T01:00:01.200Z',
        payload: {
          phase: 'ready',
          scope: 'kernel',
          durationMs: 1200,
          slowest: 'build_system_prompt',
          slowestMs: 820,
          phases: { build_system_prompt: 820, pack_turn: 210, ensure_mcp: 90 },
          note: SECRET
        }
      },
      {
        kind: 'startup_phase',
        ts: '2026-10-28T01:00:01.100Z',
        payload: { phase: 'skill_catalog', scope: 'prompt', durationMs: 180, query: SECRET }
      },
      {
        kind: 'turn_end',
        ts: '2026-10-28T01:00:04.000Z',
        payload: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
      }
    ]
  });
  const line = formatTurnFeedStatsLine(stats[0], { elapsed: '执行', input: '输入', output: '输出', startup: '启动', slowest: '最慢' }, 'zh') ?? '';
  assert.match(line, /执行 /);
  assert.match(line, /启动 1\.2s/);
  assert.match(line, /最慢 系统提示词 820ms/);
  assert.match(line, /打包消息 210ms/);
  assert.match(line, /技能目录 180ms/);
  assert.equal(line.includes(SECRET), false);
});

test('a turn without startup keeps the existing stats line [AC:lab-startup-timing#AC-3]', () => {
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-22T08:46:56.000Z' },
      { role: 'assistant', createdAt: '2026-10-22T08:47:00.000Z' }
    ],
    traces: [
      { kind: 'turn_start', ts: '2026-10-22T08:46:56.000Z' },
      {
        kind: 'turn_end',
        ts: '2026-10-22T08:47:00.000Z',
        payload: { usage: { inputTokens: 20_500, outputTokens: 275, totalTokens: 20_775 }, costUsd: 0.05 }
      }
    ]
  });
  const line = formatTurnFeedStatsLine(stats[0], endTimeLabels, 'zh') ?? '';
  assert.match(line, /^执行 4s · 输入 20\.5k · 输出 275 · \$0\.050 · 会话结束 /);
  assert.equal(line.includes('启动'), false);
});

test('English session stats name startup and the slowest phase in English [AC:lab-startup-timing#AC-4]', () => {
  const stats = buildTurnFeedStats({
    messages: [
      { role: 'user', createdAt: '2026-10-28T01:00:00.000Z' },
      { role: 'assistant', createdAt: '2026-10-28T01:00:04.000Z' }
    ],
    traces: [{
      kind: 'startup_phase',
      ts: '2026-10-28T01:00:01.000Z',
      payload: {
        phase: 'ready',
        durationMs: 900,
        slowest: 'ensure_mcp',
        slowestMs: 700,
        phases: { ensure_mcp: 700 }
      }
    }]
  });
  const line = formatTurnFeedStatsLine(stats[0], { startup: 'Startup', slowest: 'Slowest' }, 'en') ?? '';
  assert.match(line, /Startup 900ms/);
  assert.match(line, /Slowest MCP load 700ms/);
  assert.equal(line.includes('启动'), false);
  assert.equal(line.includes('最慢'), false);
});

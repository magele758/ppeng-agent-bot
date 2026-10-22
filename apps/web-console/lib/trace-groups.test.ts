import test from 'node:test';
import assert from 'node:assert/strict';
import {
  errorHintCode,
  errorPayloadMessage,
  filterTraceGroups,
  groupTraceEvents,
  maxDurationMs,
  summarizeGroup,
  summarizeTrace
} from './trace-groups.ts';

test('groupTraceEvents splits turns and tags errors', () => {
  const groups = groupTraceEvents([
    { kind: 'turn_start', ts: '2026-09-07T10:00:00.000Z' },
    { kind: 'model_delta', ts: '2026-09-07T10:00:01.000Z' },
    { kind: 'turn_end', ts: '2026-09-07T10:00:02.000Z' },
    { kind: 'turn_start', ts: '2026-09-07T10:00:03.000Z' },
    { kind: 'model_error', ts: '2026-09-07T10:00:04.000Z', payload: { message: 'boom' } },
    { kind: 'turn_end', ts: '2026-09-07T10:00:05.000Z' }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.kind, 'turn');
  assert.equal(groups[0]?.turnIndex, 1);
  assert.equal(groups[0]?.hasError, false);
  assert.equal(groups[1]?.kind, 'turn');
  assert.equal(groups[1]?.turnIndex, 2);
  assert.equal(groups[1]?.hasError, true);
  assert.equal(maxDurationMs(groups) >= 2000, true);
});

const SAMPLE = [
  { kind: 'turn_start', ts: '2026-09-07T10:00:00.000Z' },
  { kind: 'tool_start', ts: '2026-09-07T10:00:01.000Z', payload: { name: 'bash' } },
  { kind: 'tool_end', ts: '2026-09-07T10:00:02.000Z', payload: { name: 'bash' } },
  { kind: 'turn_end', ts: '2026-09-07T10:00:04.000Z', payload: { usage: { totalTokens: 1200 }, costUsd: 0.01 } },
  { kind: 'turn_start', ts: '2026-09-07T10:00:05.000Z' },
  { kind: 'model_error', ts: '2026-09-07T10:00:06.000Z', payload: { message: 'boom' } },
  { kind: 'turn_end', ts: '2026-09-07T10:00:07.000Z' }
];

test('summarizeTrace reports turns, error turns, duration and tool calls [AC:ops-console#AC-4]', () => {
  const groups = groupTraceEvents(SAMPLE);
  const overview = summarizeTrace(groups);
  assert.equal(overview.turns, 2);
  assert.equal(overview.errorTurns, 1);
  assert.equal(overview.toolCalls, 1);
  assert.equal(overview.totalDurationMs, 6000);
  assert.equal(overview.totalTokens, 1200);
  assert.equal(overview.costUsd, 0.01);
  const first = summarizeGroup(groups[0]!);
  assert.equal(first.toolCalls, 1);
  assert.equal(first.errorEvents, 0);
  assert.equal(summarizeGroup(groups[1]!).errorEvents, 1);
});

test('filterTraceGroups errorsOnly keeps only error turns [AC:ops-console#AC-5]', () => {
  const groups = groupTraceEvents(SAMPLE);
  const only = filterTraceGroups(groups, { errorsOnly: true, query: '' });
  assert.equal(only.length, 1);
  assert.equal(only[0]?.turnIndex, 2);
  assert.equal(filterTraceGroups(groups, { errorsOnly: false, query: '' }).length, 2);
  const clean = groupTraceEvents(SAMPLE.slice(0, 4));
  assert.equal(filterTraceGroups(clean, { errorsOnly: true, query: '' }).length, 0);
});

test('filterTraceGroups query narrows events and drops empty turns [AC:ops-console#AC-6]', () => {
  const groups = groupTraceEvents(SAMPLE);
  const tools = filterTraceGroups(groups, { errorsOnly: false, query: 'TOOL' });
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0]?.events.map((e) => e.kind), ['tool_start', 'tool_end']);
  assert.equal(tools[0]?.turnIndex, 1);
  assert.equal(filterTraceGroups(groups, { errorsOnly: false, query: 'nothing-like-this' }).length, 0);
});

test('errorHintCode maps known error kinds', () => {
  assert.equal(errorHintCode('model_error'), 'modelError');
  assert.equal(errorHintCode('recovery_abort'), 'recoveryAbort');
  assert.equal(errorHintCode('turn_truncated'), 'truncated');
  assert.equal(errorHintCode('goal_eval'), 'goalUnmet');
  assert.equal(errorHintCode('something_failed'), 'generic');
  assert.equal(errorPayloadMessage({ error: 'x' }), 'x');
  assert.equal(errorPayloadMessage(null), '');
});

test('[AC:ops-session-trace-repair#AC-6] unmet goals count as errors and keep the goal sentence', () => {
  const rows = [
    { kind: 'turn_start', ts: '2026-09-07T11:00:00.000Z' },
    {
      kind: 'goal_eval',
      ts: '2026-09-07T11:00:01.000Z',
      payload: { met: false, reason: 'goal not met', goal: '把登录修到能打开', title: '登录' }
    },
    { kind: 'turn_end', ts: '2026-09-07T11:00:02.000Z' },
    { kind: 'turn_start', ts: '2026-09-07T11:00:03.000Z' },
    {
      kind: 'goal_eval',
      ts: '2026-09-07T11:00:04.000Z',
      payload: { met: true, reason: 'done', goal: '已经完成的目标' }
    },
    { kind: 'turn_end', ts: '2026-09-07T11:00:05.000Z' }
  ];
  const groups = groupTraceEvents(rows);
  assert.equal(groups[0]?.hasError, true);
  assert.equal(groups[1]?.hasError, false);
  const only = filterTraceGroups(groups, { errorsOnly: true, query: '' });
  assert.equal(only.length, 1);
  assert.equal(only[0]?.turnIndex, 1);
  assert.equal(errorPayloadMessage(rows[1]?.payload), '把登录修到能打开 — goal not met');
  assert.equal(
    errorPayloadMessage({ met: false, reason: '编译仍然失败', title: '登录' }),
    '登录 — 编译仍然失败'
  );
  const overview = summarizeTrace(groups);
  assert.equal(overview.turns, 2);
  assert.equal(overview.errorTurns, 1);
});

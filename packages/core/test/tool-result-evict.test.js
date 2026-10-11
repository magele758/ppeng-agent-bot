import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assistantFollowsToolResult,
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactMessages
} from '../dist/session/micro-compact.js';
import {
  formatExperimentReport,
  runToolResultEvictExperiment
} from '../dist/session/tool-result-evict-experiment.js';

function toolMsg(id, name, content, ok = true) {
  return {
    id,
    sessionId: 's1',
    role: 'tool',
    parts: [{ type: 'tool_result', toolCallId: `c-${id}`, name, ok, content }],
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function assistant(id, text) {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    parts: [{ type: 'text', text }],
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function assistantCall(id) {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    parts: [{ type: 'tool_call', toolCallId: `c-${id}`, name: 'bash', input: { command: 'x' } }],
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

const AFTER_ANY = {
  ...DEFAULT_MICRO_COMPACT_CONFIG,
  keepRecent: 0,
  minChars: 10,
  policy: 'after_any_assistant'
};

const AFTER_TEXT = { ...AFTER_ANY, policy: 'after_text_assistant' };

test('after_any keeps unconsumed results and stubs ones followed by an assistant', () => {
  const input = [
    toolMsg('1', 'bash', 'a'.repeat(400)),
    assistant('2', 'ok'),
    toolMsg('3', 'bash', 'b'.repeat(400))
  ];
  const { messages, stats } = microCompactMessages(input, AFTER_ANY);
  assert.equal(stats.collapsed, 1);
  assert.match(messages[0].parts[0].content, /\[previous: used bash/);
  assert.equal(messages[2].parts[0].content, 'b'.repeat(400));
});

test('after_text does not evict across a tool-call-only assistant turn', () => {
  const input = [
    toolMsg('1', 'bash', 'listing-SECRET'.padEnd(400, 'x')),
    assistantCall('2'),
    toolMsg('3', 'read_file', 'body'.padEnd(400, 'y'))
  ];
  const any = microCompactMessages(input, AFTER_ANY);
  const text = microCompactMessages(input, AFTER_TEXT);
  assert.match(any.messages[0].parts[0].content, /omitted to save space/);
  assert.equal(text.messages[0].parts[0].content, input[0].parts[0].content);
  assert.equal(text.messages[2].parts[0].content, input[2].parts[0].content);
});

test('assistantFollowsToolResult distinguishes text vs any assistant', () => {
  const messages = [toolMsg('1', 'bash', 'x'), assistantCall('2'), assistant('3', 'done')];
  assert.equal(assistantFollowsToolResult(messages, 0, false), true);
  assert.equal(assistantFollowsToolResult([messages[0], messages[1]], 0, true), false);
  assert.equal(assistantFollowsToolResult(messages, 0, true), true);
});

test('default keep_recent policy is unchanged when policy omitted', () => {
  const input = [
    toolMsg('1', 'bash', 'a'.repeat(400)),
    toolMsg('2', 'bash', 'b'.repeat(400)),
    toolMsg('3', 'bash', 'c'.repeat(400)),
    toolMsg('4', 'bash', 'd'.repeat(400))
  ];
  const { stats } = microCompactMessages(input, {
    ...DEFAULT_MICRO_COMPACT_CONFIG,
    keepRecent: 2,
    minChars: 10
  });
  assert.equal(stats.collapsed, 2);
});

test('tool-result eviction experiment encodes compression vs quality tradeoff', () => {
  const report = runToolResultEvictExperiment();
  assert.ok(report.verdicts.length >= 5);
  assert.ok(
    report.verdicts.every((line) => line.startsWith('PASS:')),
    `unexpected verdicts:\n${report.verdicts.join('\n')}`
  );

  const silentFollow = report.cases
    .find((c) => c.id === 'silent_digest')
    .snapshots.find((s) => s.id === 'followup_turn');
  const afterAny = silentFollow.scores.find((s) => s.policy === 'after_any_assistant');
  const keep3 = silentFollow.scores.find((s) => s.policy === 'keep_recent_3');
  assert.ok(afterAny.missingFacts.includes('secret-ledger-7f3a.json'));
  assert.equal(keep3.missingFacts.length, 0);

  const pending = report.cases
    .find((c) => c.id === 'unconsumed_wave')
    .snapshots.find((s) => s.id === 'pending');
  const afterPending = pending.scores.find((s) => s.policy === 'after_any_assistant');
  const keep0 = pending.scores.find((s) => s.policy === 'keep_recent_0');
  assert.equal(afterPending.missingFacts.length, 0);
  assert.ok(keep0.missingFacts.length > 0);

  const text = formatExperimentReport(report);
  assert.match(text, /Tool-result eviction experiment/);
  assert.match(text, /after_any_assistant/);
});

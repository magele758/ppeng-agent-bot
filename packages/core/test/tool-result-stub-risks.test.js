/**
 * Executable answers to: does the model still see it used a tool,
 * can read_file recover a stubbed result, and will stubs cause a same-tool loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AdvisoryGrace } from '../dist/recovery/advisory-grace.js';
import { SessionLoopGuard } from '../dist/recovery/session-loop-guard.js';
import {
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactMessages
} from '../dist/session/micro-compact.js';
import { runToolResultEvictExperiment } from '../dist/session/tool-result-evict-experiment.js';

const TS = '2026-09-02T00:00:00.000Z';
const AFTER_TEXT = {
  ...DEFAULT_MICRO_COMPACT_CONFIG,
  keepRecent: 0,
  minChars: 10,
  policy: 'after_text_assistant'
};
const AFTER_ANY = { ...AFTER_TEXT, policy: 'after_any_assistant' };

function msg(id, role, parts) {
  return { id, sessionId: 'risk', role, parts, createdAt: TS };
}

function user(id, text) {
  return msg(id, 'user', [{ type: 'text', text }]);
}

function assistantText(id, text) {
  return msg(id, 'assistant', [{ type: 'text', text }]);
}

function assistantCall(id, toolCallId, name, input) {
  return msg(id, 'assistant', [{ type: 'tool_call', toolCallId, name, input }]);
}

function toolResult(id, toolCallId, name, content, ok = true) {
  return msg(id, 'tool', [{ type: 'tool_result', toolCallId, name, ok, content }]);
}

function flattenView(messages) {
  const calls = [];
  const results = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_call') {
        calls.push({
          name: part.name,
          toolCallId: part.toolCallId,
          input: part.input
        });
      }
      if (part.type === 'tool_result') {
        results.push({
          name: part.name,
          toolCallId: part.toolCallId,
          content: part.content,
          ok: part.ok
        });
      }
    }
  }
  return { calls, results };
}

test('Q1: stub keeps tool_call pairing and names the tool; it does not keep the body', () => {
  const path = 'secret-ledger-7f3a.json';
  const body = `LEDGER_HASH=9c2e1b${'x'.repeat(400)}`;
  const input = [
    user('u1', 'Read the ledger'),
    assistantCall('a1', 'c1', 'read_file', { path }),
    toolResult('t1', 'c1', 'read_file', body),
    assistantText('a2', 'I have read the ledger file.'),
    user('u2', 'What is the hash?')
  ];

  const { messages, stats } = microCompactMessages(input, AFTER_TEXT);
  assert.equal(stats.collapsed, 1);

  const view = flattenView(messages);
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].name, 'read_file');
  assert.equal(view.calls[0].toolCallId, 'c1');
  assert.equal(view.calls[0].input.path, path);
  assert.equal(view.results[0].toolCallId, 'c1');
  assert.match(view.results[0].content, /\[previous: used read_file/);
  assert.match(view.results[0].content, /earlier tool output was omitted to save space/);
  assert.equal(view.results[0].content.includes('LEDGER_HASH=9c2e1b'), false);
  assert.equal(input[2].parts[0].content, body, 'stored transcript stays intact');
});

test('Q2: read_file can recover if the path is still on the surviving tool_call', () => {
  const path = 'secret-ledger-7f3a.json';
  const disk = new Map([[path, 'LEDGER_HASH=9c2e1b']]);
  const input = [
    user('u1', 'Read the ledger'),
    assistantCall('a1', 'c1', 'read_file', { path }),
    toolResult('t1', 'c1', 'read_file', `${disk.get(path)}${'x'.repeat(400)}`),
    assistantText('a2', 'Done.'),
    user('u2', 'Hash?')
  ];

  const view = flattenView(microCompactMessages(input, AFTER_TEXT).messages);
  const recoverable = view.calls
    .filter((call) => call.name === 'read_file' && typeof call.input.path === 'string')
    .map((call) => disk.get(call.input.path))
    .filter(Boolean);

  assert.deepEqual(recoverable, ['LEDGER_HASH=9c2e1b']);
  assert.equal(
    view.results.some((result) => result.content.includes('LEDGER_HASH=9c2e1b')),
    false,
    'hash is gone from the stubbed tool_result'
  );
});

test('Q2: read_file cannot recover a filename that only lived in stubbed ls stdout', () => {
  const filename = 'secret-ledger-7f3a.json';
  const listing = `files:\n- notes-old-backup.md\n- ${filename}\n- README.md${'x'.repeat(400)}`;
  const input = [
    user('u1', 'List files'),
    assistantCall('a1', 'c1', 'bash', { command: 'ls' }),
    toolResult('t1', 'c1', 'bash', listing),
    assistantText('a2', 'Listed the directory.'),
    user('u2', 'What was the ledger filename?')
  ];

  const view = flattenView(microCompactMessages(input, AFTER_TEXT).messages);
  const blob = [
    ...view.calls.map((call) => JSON.stringify(call.input)),
    ...view.results.map((result) => result.content)
  ].join('\n');

  assert.equal(view.calls[0].input.command, 'ls');
  assert.equal(blob.includes(filename), false);
  assert.equal(
    view.calls.some((call) => call.name === 'read_file'),
    false,
    'no surviving path for read_file to follow'
  );
});

test('Q3: after_text keeps the listing during a tool-only streak; after_any drops it', () => {
  const filename = 'secret-ledger-7f3a.json';
  const listing = `files:\n- ${filename}${'x'.repeat(400)}`;
  const input = [
    user('u1', 'Read the ledger'),
    assistantCall('a1', 'c1', 'bash', { command: 'ls' }),
    toolResult('t1', 'c1', 'bash', listing),
    assistantCall('a2', 'c2', 'read_file', { path: filename }),
    toolResult('t2', 'c2', 'read_file', `body${'y'.repeat(400)}`)
  ];

  const any = flattenView(microCompactMessages(input, AFTER_ANY).messages);
  const text = flattenView(microCompactMessages(input, AFTER_TEXT).messages);

  assert.match(any.results[0].content, /omitted to save space/);
  assert.equal(any.results[0].content.includes(filename), false);
  assert.equal(text.results[0].content, listing);
});

test('Q3: stub-induced same tool-call re-calls still trip LoopGuard after grace', () => {
  const guard = new SessionLoopGuard({ RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3' });
  const grace = new AdvisoryGrace(1);
  const sameLs = [{ name: 'bash', input: { command: 'ls' } }];

  const rounds = [];
  for (let i = 0; i < 4; i++) {
    const raw = guard.afterToolRound(sameLs, [{ name: 'bash', ok: true }]);
    rounds.push(grace.apply(raw));
  }

  assert.equal(rounds[0].action, 'continue');
  assert.equal(rounds[1].action, 'continue');
  assert.equal(rounds[2].action, 'advise');
  assert.match(rounds[2].advisory, /recovery-advisory/);
  assert.equal(rounds[3].action, 'abort');
  assert.match(rounds[3].reason, /same tool-call content/);
  assert.match(rounds[3].reason, /bash/);
});

test('offline experiment records the remember / read-back / ls-stdout cases', () => {
  const report = runToolResultEvictExperiment();
  const index = report.cases.find((item) => item.id === 'call_index_survives');
  assert.ok(index);
  const after = index.snapshots
    .find((item) => item.id === 'after_consume')
    .scores.find((item) => item.policy === 'after_text_assistant');
  const lsOnly = index.snapshots
    .find((item) => item.id === 'ls_stdout_only')
    .scores.find((item) => item.policy === 'after_text_assistant');

  assert.equal(after.missingFacts.includes('secret-ledger-7f3a.json'), false);
  assert.ok(after.missingFacts.includes('LEDGER_HASH=9c2e1b'));
  assert.ok(lsOnly.missingFacts.includes('secret-ledger-7f3a.json'));
  assert.ok(
    report.verdicts.some((line) => line.includes('call_index_survives') || line.includes('路径线索'))
  );
});

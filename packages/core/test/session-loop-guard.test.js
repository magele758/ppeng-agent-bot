import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionLoopGuard } from '../dist/recovery/session-loop-guard.js';

test('afterToolRound aborts on consecutive tool failures', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '3'
  });
  assert.equal(g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: false }]).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: false }]).abort, false);
  const third = g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: false }]);
  assert.equal(third.abort, true);
  assert.match(third.reason, /bash/);
});

test('afterToolRound resets streak on success', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '2'
  });
  g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: false }]);
  assert.equal(g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: true }]).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash' }], [{ name: 'bash', ok: false }]).abort, false);
});

test('checkAssistantRepetition aborts on identical fingerprints', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_REPEAT_WINDOW: '8',
    RAW_AGENT_RECOVERY_REPEAT_RATIO: '0.75'
  });
  const parts = [{ type: 'text', text: 'same' }];
  for (let i = 0; i < 3; i++) {
    assert.equal(g.checkAssistantRepetition(parts).abort, false);
  }
  const fourth = g.checkAssistantRepetition(parts);
  assert.equal(fourth.abort, true);
});

test('afterToolRound same-name different args does not abort', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3',
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '99'
  });
  const ok = [{ name: 'bash', ok: true }];
  assert.equal(g.afterToolRound([{ name: 'bash', input: { command: 'ls' } }], ok).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash', input: { command: 'cat a' } }], ok).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash', input: { command: 'grep x' } }], ok).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash', input: { command: 'pwd' } }], ok).abort, false);
  assert.equal(g.afterToolRound([{ name: 'bash', input: { command: 'whoami' } }], ok).abort, false);
});

test('afterToolRound aborts when the same tool-call content repeats', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3',
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '99'
  });
  const call = [{ name: 'bash', input: { command: 'ls', timeout: 1 } }];
  const reordered = [{ name: 'bash', input: { timeout: 1, command: 'ls' } }];
  const ok = [{ name: 'bash', ok: true }];
  assert.equal(g.afterToolRound(call, ok).abort, false);
  assert.equal(g.afterToolRound(reordered, ok).abort, false);
  const t = g.afterToolRound(call, ok);
  assert.equal(t.abort, true);
  assert.match(t.reason, /repeat detection: same tool-call content/);
  assert.match(t.reason, /bash/);
  assert.doesNotMatch(t.reason, /first tool/);
});

test('afterToolRound retains each full sequence without new successful evidence [AC:tool-progress-guard#AC-2]', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '3',
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '99'
  });
  const ok = [
    { name: 'bash', ok: true },
    { name: 'read_file', ok: true }
  ];
  const seqA = [
    { name: 'bash', input: { command: 'ls' } },
    { name: 'read_file', input: { path: 'a.txt' } }
  ];
  const seqB = [
    { name: 'bash', input: { command: 'ls' } },
    { name: 'read_file', input: { path: 'b.txt' } }
  ];
  const seqSwapped = [
    { name: 'read_file', input: { path: 'a.txt' } },
    { name: 'bash', input: { command: 'ls' } }
  ];
  assert.equal(g.afterToolRound(seqA, ok).abort, false);
  assert.equal(g.afterToolRound(seqB, ok).abort, false);
  assert.equal(g.afterToolRound(seqSwapped, ok).abort, false);
  assert.equal(g.afterToolRound(seqA, ok).abort, false);
  // Other call sequences without result content do not prove progress on seqA.
  const hit = g.afterToolRound(seqA, ok);
  assert.equal(hit.abort, true);
  assert.match(hit.reason, /same tool-call content/);
  assert.match(hit.reason, /bash/);
  assert.match(hit.reason, /read_file/);
});

test('afterToolRound fail streak is independent of call-content streak', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_TOOL_FAIL_STREAK: '3',
    RAW_AGENT_RECOVERY_SAME_TOOL_STREAK: '99'
  });
  assert.equal(
    g.afterToolRound([{ name: 'bash', input: { command: 'ls' } }], [{ name: 'bash', ok: false }]).abort,
    false
  );
  assert.equal(
    g.afterToolRound([{ name: 'bash', input: { command: 'cat' } }], [{ name: 'bash', ok: false }]).abort,
    false
  );
  const third = g.afterToolRound(
    [{ name: 'bash', input: { command: 'grep' } }],
    [{ name: 'bash', ok: false }]
  );
  assert.equal(third.abort, true);
  assert.match(third.reason, /failed 3 times/);
});

test('checkAssistantRepetition preserves nested tool arguments in fingerprint', () => {
  const g = new SessionLoopGuard({
    RAW_AGENT_RECOVERY_REPEAT_WINDOW: '8',
    RAW_AGENT_RECOVERY_REPEAT_RATIO: '0.75'
  });
  const base = {
    type: 'tool_call',
    name: 'bash',
    toolCallId: 'call_1'
  };

  assert.equal(
    g.checkAssistantRepetition([
      {
        ...base,
        input: { payload: { command: 'echo one', options: { timeout_ms: 1000 } } }
      }
    ]).abort,
    false
  );
  assert.equal(
    g.checkAssistantRepetition([
      {
        ...base,
        input: { payload: { command: 'echo two', options: { timeout_ms: 1000 } } }
      }
    ]).abort,
    false
  );
  assert.equal(
    g.checkAssistantRepetition([
      {
        ...base,
        input: { payload: { command: 'echo three', options: { timeout_ms: 1000 } } }
      }
    ]).abort,
    false
  );
  assert.equal(
    g.checkAssistantRepetition([
      {
        ...base,
        input: { payload: { command: 'echo four', options: { timeout_ms: 1000 } } }
      }
    ]).abort,
    false
  );
});

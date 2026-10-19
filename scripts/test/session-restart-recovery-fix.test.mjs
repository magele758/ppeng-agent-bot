import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRestartRuntime } from '../formal/restart-verifier.mjs';
const cases = [
  'model-chat-SIGKILL', 'retry-task-SIGTERM', 'tool-task-SIGKILL',
  'approval-one-chat-SIGKILL', 'approval-settled-chat-SIGTERM', 'approval-mixed-chat-SIGKILL',
  'approval-partial-cancel-chat-SIGKILL', 'partial-tools-task-SIGKILL'
];
let evidence;
async function passing(names) {
  const report = await (evidence ??= verifyRestartRuntime({ only: cases }));
  assert.equal(report.completed, true, JSON.stringify(report));
  for (const name of names) {
    const row = report.scenarios.find(s => s.name === name);
    assert.equal(row?.status, 'pass', JSON.stringify(row));
  }
}
test('interrupted model/tool/retry work does not block fresh runs [AC:session-restart-recovery-state-consistency#AC-1]', () => passing(['model-chat-SIGKILL', 'retry-task-SIGTERM', 'tool-task-SIGKILL']));
test('durable approvals accept decisions and resume permitted work after restart [AC:session-restart-recovery-state-consistency#AC-2]', () => passing(['approval-one-chat-SIGKILL', 'approval-settled-chat-SIGTERM', 'approval-mixed-chat-SIGKILL']));
test('cancelled restored approval leaves the next run usable [AC:session-restart-recovery-state-consistency#AC-3]', () => passing(['approval-partial-cancel-chat-SIGKILL']));
test('saved and unconfirmed tool results reach the next model with valid pairing [AC:session-restart-recovery-state-consistency#AC-4]', () => passing(['partial-tools-task-SIGKILL']));

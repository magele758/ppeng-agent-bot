/**
 * In-process E2E with MockLlmProvider (ai-agent-node ScriptedAdapter pattern).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RawAgentRuntime,
  createMockLlm,
  mockText,
  mockToolUse,
  assertTranscriptInvariants,
  unmatchedToolCallIds
} from '../dist/exports/public.js';

function runtimeWithMock(script) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'mock-llm-repo-'));
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs', 'readme.md'), 'hello');
  const stateDir = mkdtempSync(join(tmpdir(), 'mock-llm-state-'));
  const model = createMockLlm(script);
  return {
    model,
    runtime: new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: model })
  };
}

test('mock-llm e2e: text-only turn ends idle and records the prompt', async () => {
  const { runtime, model } = runtimeWithMock([mockText('hello from mock')]);
  const session = runtime.createChatSession({ title: 't', message: 'hi' });
  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(session.id), 'hello from mock');
  assert.equal(model.calls.length, 1);
  assertTranscriptInvariants(runtime.getSessionMessages(session.id));
});

test('mock-llm e2e: tool_use then text keeps pairing closed', async () => {
  const { runtime } = runtimeWithMock([
    mockToolUse({ name: 'read_file', input: { path: 'docs' } }),
    mockText('listed')
  ]);
  const session = runtime.createChatSession({ title: 'ls', message: 'list docs' });
  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'idle');
  const msgs = runtime.getSessionMessages(session.id);
  assert.deepEqual(unmatchedToolCallIds(msgs), []);
  assertTranscriptInvariants(msgs);
  assert.equal(runtime.getLatestAssistantText(session.id), 'listed');
});

test('mock-llm e2e: unknown tool still pairs tool_call↔result', async () => {
  const { runtime } = runtimeWithMock([
    mockToolUse({ name: 'not_a_real_tool', input: {} }),
    mockText('recovered')
  ]);
  const session = runtime.createChatSession({ title: 'unk', message: 'do mystery' });
  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'idle');
  const msgs = runtime.getSessionMessages(session.id);
  assert.deepEqual(unmatchedToolCallIds(msgs), []);
  const results = msgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
  assert.ok(results.some((p) => p.toolCallId && p.name === 'not_a_real_tool'));
  assertTranscriptInvariants(msgs);
});

test('mock-llm e2e: approval latch then resume', async () => {
  const { runtime } = runtimeWithMock((input) => {
    const approved = input.messages.some(
      (m) =>
        m.role === 'user' &&
        m.parts.some((p) => p.type === 'text' && String(p.text).includes('approved'))
    );
    if (!approved) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'mock_rm',
            name: 'bash',
            input: {
              command: 'rm -rf /tmp/formal-mock',
              requestSmartModeApproval: true,
              smartModeBlockReason: 'Auto-review blocked high-risk bash'
            }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done after approval' }] };
  });
  const session = runtime.createChatSession({ title: 'appr', message: 'rm something' });
  const blocked = await runtime.runSession(session.id);
  assert.equal(blocked.status, 'waiting_approval');
  const approvals = runtime.listApprovals();
  assert.equal(approvals.length, 1);
  await runtime.approve(approvals[0].id, 'approved');
  const done = await runtime.runSession(session.id);
  assert.equal(done.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(session.id), 'done after approval');
  assertTranscriptInvariants(runtime.getSessionMessages(session.id));
});

test('mock-llm e2e: two user turns keep pairing closed', async () => {
  const { runtime } = runtimeWithMock([mockText('one'), mockText('two')]);
  const session = runtime.createChatSession({ title: 'multi', message: 'first' });
  await runtime.runSession(session.id);
  runtime.sendUserMessage(session.id, 'second');
  await runtime.runSession(session.id);
  assert.equal(runtime.getLatestAssistantText(session.id), 'two');
  assertTranscriptInvariants(runtime.getSessionMessages(session.id));
});

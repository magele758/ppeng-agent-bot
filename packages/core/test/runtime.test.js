/**
 * kernel-lock: chat path + parallel tool calls in one assistant message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { NotFoundError, ValidationError } from '../dist/errors.js';

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
  }

  async runTurn(input) {
    return this.handler(input);
  }

  async summarizeMessages() {
    return 'summary';
  }
}

function runtimeWithAdapter(adapter) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'raw-agent-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'raw-agent-state-'));
  return new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: adapter
  });
}

test('chat session can do a simple reply through the raw loop', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'Hello from the loop.' }]
    }))
  );

  const session = runtime.createChatSession({
    title: 'hello',
    message: 'hello'
  });

  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(session.id), 'Hello from the loop.');
});

test('task sessions complete and bind an isolated workspace', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'Task handled.' }]
    }))
  );

  const { task, session } = runtime.createTaskSession({
    title: 'Implement feature',
    description: 'Do the work'
  });

  await runtime.runSession(session.id);

  const updatedTask = runtime.getTask(task.id);
  const updatedSession = runtime.getSession(session.id);
  assert.ok(updatedTask);
  assert.ok(updatedTask.workspaceId);
  assert.equal(updatedTask.status, 'completed');
  assert.ok(updatedSession.workspaceId);
});

test('approval blocks the session until the user approves the tool call', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const sawApprovalNote = input.messages.some(
        (message) =>
          message.role === 'user' &&
          message.parts.some((part) => part.type === 'text' && part.text.includes('Approval for bash was approved'))
      );

      if (!sawApprovalNote) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'call_1',
              name: 'bash',
              input: {
                command: 'rm -rf /tmp/example'
              }
            }
          ]
        };
      }

      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'Continuing after approval.' }]
      };
    })
  );

  const session = runtime.createChatSession({
    title: 'approval',
    message: 'run the risky command'
  });

  const blocked = await runtime.runSession(session.id);
  assert.equal(blocked.status, 'waiting_approval');

  const approvals = runtime.listApprovals();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'bash');

  await runtime.approve(approvals[0].id, 'approved');
  const completed = await runtime.runSession(session.id);
  assert.equal(completed.status, 'idle');
  assert.equal(runtime.getLatestAssistantText(session.id), 'Continuing after approval.');
});

test('read_file can list a directory passed by path', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const dirResult = input.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool_result' && part.name === 'read_file');

      if (!dirResult) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'call_dir',
              name: 'read_file',
              input: {
                path: 'docs'
              }
            }
          ]
        };
      }

      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: dirResult.content }]
      };
    })
  );

  mkdirSync(join(runtime.repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(runtime.repoRoot, 'docs', 'note.txt'), 'hello');

  const session = runtime.createChatSession({
    title: 'dir listing',
    message: 'show me docs'
  });

  await runtime.runSession(session.id);
  assert.match(runtime.getLatestAssistantText(session.id) ?? '', /file note\.txt/);
});

test('tool execution errors are returned to the model instead of crashing the session', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const errorResult = input.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === 'tool_result' && part.name === 'read_file' && part.ok === false);

      if (!errorResult) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'call_missing',
              name: 'read_file',
              input: {
                path: 'missing.txt'
              }
            }
          ]
        };
      }

      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'Handled tool failure gracefully.' }]
      };
    })
  );

  const session = runtime.createTaskSession({
    title: 'tool failure',
    description: 'exercise tool error path'
  }).session;

  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'completed');
  assert.equal(runtime.getLatestAssistantText(session.id), 'Handled tool failure gracefully.');
});

test('optional tool groups only filter sessions with explicit selection metadata', async () => {
  const prev = process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS;
  process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS = '1';
  try {
    const seenToolSets = [];
    const runtime = runtimeWithAdapter(
      new ScriptedAdapter((input) => {
        seenToolSets.push(input.tools.map((tool) => tool.name));
        return {
          stopReason: 'end',
          assistantParts: [{ type: 'text', text: 'done' }]
        };
      })
    );

    const defaultChat = runtime.createChatSession({
      title: 'default chat',
      message: 'hello'
    });
    await runtime.runSession(defaultChat.id);

    const explicitOptOut = runtime.createChatSession({
      title: 'explicit opt-out',
      message: 'hello',
      metadata: { enabledOptionalToolGroups: [] }
    });
    await runtime.runSession(explicitOptOut.id);

    const taskSession = runtime.createTaskSession({
      title: 'task keeps default tools',
      description: 'exercise internal sessions'
    }).session;
    await runtime.runSession(taskSession.id);

    assert.ok(seenToolSets[0].includes('bash'), 'sessions without explicit selection should keep optional tools');
    assert.ok(!seenToolSets[1].includes('bash'), 'explicit empty selection should filter optional tools');
    assert.ok(seenToolSets[2].includes('bash'), 'internal task sessions should keep optional tools by default');
  } finally {
    if (prev === undefined) delete process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS;
    else process.env.RAW_AGENT_OPTIONAL_TOOL_GROUPS = prev;
  }
});

test('teammate sessions and mailbox messages can be created directly', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'Teammate online.' }]
    }))
  );

  const session = runtime.createTeammateSession({
    name: 'qa-bot',
    role: 'QA specialist',
    prompt: 'Watch for bugs.'
  });

  await runtime.runSession(session.id);
  const mail = runtime.sendMailboxMessage({
    fromAgentId: 'main',
    toAgentId: 'qa-bot',
    content: 'Check the latest task.'
  });

  assert.equal(session.mode, 'teammate');
  assert.equal(mail.toAgentId, 'qa-bot');
  assert.equal(runtime.listMailbox('qa-bot').length, 1);
  const pending = runtime.countPendingMailboxByRecipient();
  assert.equal(pending.total, 1);
  assert.equal(pending.byRecipientAgentId['qa-bot'], 1);
});

test('parallel tool calls execute in one assistant message', async () => {
  const seen = [];
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const results = input.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result' && p.name === 'read_file');
      if (results.length < 2) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            { type: 'tool_call', toolCallId: 'a', name: 'read_file', input: { path: 'a.txt' } },
            { type: 'tool_call', toolCallId: 'b', name: 'read_file', input: { path: 'b.txt' } }
          ]
        };
      }
      seen.push(...results.map((r) => r.content));
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'done' }]
      };
    })
  );

  writeFileSync(join(runtime.repoRoot, 'a.txt'), 'A');
  writeFileSync(join(runtime.repoRoot, 'b.txt'), 'B');

  const session = runtime.createChatSession({ title: 'parallel', message: 'read both' });
  await runtime.runSession(session.id);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /A/);
  assert.match(seen[1], /B/);
});

test('scratch memory is copied to subagent session', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      if (input.agent.id === 'researcher') {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'sub done' }] };
      }
      const hasSub = input.messages.some((m) =>
        m.parts.some((p) => p.type === 'tool_result' && p.name === 'spawn_subagent')
      );
      if (!hasSub) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 's1',
              name: 'spawn_subagent',
              input: { prompt: 'Say hi only.', role: 'research' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
    })
  );

  const session = runtime.createChatSession({ title: 'handoff', message: 'go' });
  runtime.store.upsertSessionMemory({
    sessionId: session.id,
    scope: 'scratch',
    key: 'ctx',
    value: 'shared-secret'
  });
  runtime.store.upsertSessionMemory({
    sessionId: session.id,
    scope: 'scratch',
    key: 'ptc.plan',
    value: 'v1',
    source: 'ptc'
  });

  await runtime.runSession(session.id);

  const sub = runtime.listSessions().find((s) => s.mode === 'subagent' && s.parentSessionId === session.id);
  assert.ok(sub);
  const mem = runtime.store.listSessionMemory(sub.id, 'scratch');
  assert.equal(mem.find((m) => m.key === 'ctx')?.value, 'shared-secret');
  assert.equal(mem.find((m) => m.key === 'ptc.plan')?.value, 'v1');
});

test('read_file offset_line returns a window', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const tr = input.messages
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'tool_result' && p.name === 'read_file');
      if (!tr) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'r1',
              name: 'read_file',
              input: { path: 'lines.txt', offset_line: 2, limit: 2 }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: tr.content }] };
    })
  );

  writeFileSync(join(runtime.repoRoot, 'lines.txt'), ['L0', 'L1', 'L2', 'L3'].join('\n'));
  const session = runtime.createChatSession({ title: 'offset', message: 'x' });
  await runtime.runSession(session.id);
  const text = runtime.getLatestAssistantText(session.id) ?? '';
  assert.match(text, /L2/);
  assert.match(text, /L3/);
});

test('scheduler dequeue wakes sessions enqueued on task create', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'woke' }]
    }))
  );

  const bg = runtime.createChatSession({ title: 'bg', message: 'idle', background: true });
  runtime.store.updateSession(bg.id, { mode: 'task' });
  const { task } = runtime.createTaskSession({ title: 'new work', description: 'd' });
  assert.ok(task);

  await runtime.runScheduler();
  await runtime.autonomousScheduler.whenIdle();
  const s = runtime.getSession(bg.id);
  assert.equal(s?.status, 'completed');
  assert.equal(runtime.getLatestAssistantText(bg.id), 'woke');
});

test('harness_write_spec writes under repo when no workspace', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const hasHarness = input.messages.some((m) =>
        m.parts.some((p) => p.type === 'tool_result' && p.name === 'harness_write_spec')
      );
      if (!hasHarness) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'h1',
              name: 'harness_write_spec',
              input: { kind: 'product_spec', content: '# Spec\nhello' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
    })
  );

  const session = runtime.createChatSession({ title: 'harness', message: 'x' });
  await runtime.runSession(session.id);
  const fs = await import('node:fs/promises');
  const specPath = join(runtime.repoRoot, '.raw-agent-harness', 'product_spec.md');
  const text = await fs.readFile(specPath, 'utf8');
  assert.match(text, /hello/);
});

test('harness_write_spec writes requirements_backlog under repo when no workspace', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      const hasHarness = input.messages.some((m) =>
        m.parts.some((p) => p.type === 'tool_result' && p.name === 'harness_write_spec')
      );
      if (!hasHarness) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'h1',
              name: 'harness_write_spec',
              input: { kind: 'requirements_backlog', content: '# REQ\n1. [ ] smoke' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
    })
  );

  const session = runtime.createChatSession({ title: 'harness-req', message: 'x' });
  await runtime.runSession(session.id);
  const fs = await import('node:fs/promises');
  const specPath = join(runtime.repoRoot, '.raw-agent-harness', 'requirements_backlog.md');
  const text = await fs.readFile(specPath, 'utf8');
  assert.match(text, /smoke/);
});

test('task_update merges metadata shallowly', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'x' }] }))
  );
  const session = runtime.createChatSession({ title: 'meta', message: 'x' });
  const tool = runtime.tools.find((t) => t.name === 'task_update');
  assert.ok(tool);
  const ctx = {
    repoRoot: runtime.repoRoot,
    stateDir: runtime.stateDir,
    session: runtime.getSession(session.id),
    agent: runtime.listAgents().find((a) => a.id === 'main')
  };
  const created = await runtime.store.createTask({
    title: 't',
    description: '',
    sessionId: session.id
  });
  await tool.execute(ctx, { taskId: created.id, metadata: { sprint: 'a', n: 1 } });
  await tool.execute(ctx, { taskId: created.id, metadata: { n: 2, extra: true } });
  const t = runtime.getTask(created.id);
  assert.equal(t.metadata.sprint, 'a');
  assert.equal(t.metadata.n, 2);
  assert.equal(t.metadata.extra, true);
});

test('createApproval idempotency key returns same pending row', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'x' }] }))
  );
  const session = runtime.createChatSession({ title: 'idem', message: 'x' });
  const a1 = runtime.store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'r',
    args: { command: 'echo' },
    idempotencyKey: 'idem-k'
  });
  const a2 = runtime.store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'r',
    args: { command: 'echo' },
    idempotencyKey: 'idem-k'
  });
  assert.equal(a1.id, a2.id);
});

test('external AI tools are absent unless RAW_AGENT_EXTERNAL_AI_TOOLS is set', () => {
  delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'x' }] }))
  );
  const names = runtime.tools.map((t) => t.name);
  assert.ok(!names.includes('claude_code'));
  assert.ok(!names.includes('codex_exec'));
  assert.ok(!names.includes('cursor_agent'));
});

test('external AI tools are registered when RAW_AGENT_EXTERNAL_AI_TOOLS=1', () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    const runtime = runtimeWithAdapter(
      new ScriptedAdapter(() => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'x' }] }))
    );
    const names = runtime.tools.map((t) => t.name);
    assert.ok(names.includes('claude_code'));
    assert.ok(names.includes('codex_exec'));
    assert.ok(names.includes('cursor_agent'));
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

// ─── External AI tool gate enforcement tests ──────────────────────────────────────────

test('external AI tools: not exposed when env gate is off even if session opts in', async () => {
  delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;

  let capturedTools = [];
  const runtime = runtimeWithAdapter(new ScriptedAdapter((input) => {
    capturedTools = input.tools.map(t => t.name);
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  }));

  const session = runtime.createChatSession({
    title: 'test',
    message: 'go',
    metadata: { allowExternalAiTools: true }
  });
  await runtime.runSession(session.id);
  assert.ok(!capturedTools.includes('claude_code'), 'claude_code should be absent when env gate is off');
});

test('external AI tools: not exposed when env gate is on but session does not opt in', async () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    let capturedTools = [];
    const runtime = runtimeWithAdapter(new ScriptedAdapter((input) => {
      capturedTools = input.tools.map(t => t.name);
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    }));

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go'
      // no allowExternalAiTools: true
    });
    await runtime.runSession(session.id);
    assert.ok(!capturedTools.includes('claude_code'), 'claude_code should be absent when session does not opt in');
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

test('external AI tools: exposed only when both env gate and session opt-in are set', async () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    let capturedTools = [];
    const runtime = runtimeWithAdapter(new ScriptedAdapter((input) => {
      capturedTools = input.tools.map(t => t.name);
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    }));

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go',
      metadata: { allowExternalAiTools: true }
    });
    await runtime.runSession(session.id);
    assert.ok(capturedTools.includes('claude_code'), 'claude_code should be present when both gate and opt-in are set');
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

test('external AI tools: always require approval by default', async () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    const runtime = runtimeWithAdapter(new ScriptedAdapter(() => {
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: 'call_ext',
          name: 'claude_code',
          input: { prompt: 'hello' }
        }]
      };
    }));

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go',
      metadata: { allowExternalAiTools: true }
    });
    const result = await runtime.runSession(session.id);
    assert.equal(result.status, 'waiting_approval');

    const approvals = runtime.listApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].toolName, 'claude_code');
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

test('external AI tools: tool result carries isExternal flag', async () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    const runtime = runtimeWithAdapter(new ScriptedAdapter((input) => {
      // Check if we already have the result
      const sawResult = input.messages.some(m => m.parts.some(p => p.type === 'tool_result' && p.name === 'claude_code'));
      if (sawResult) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      }

      // If not, model emits/re-emits the tool call
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: 'call_ext_1',
          name: 'claude_code',
          input: { prompt: 'echo hello' }
        }]
      };
    }));

    // Mock execute to skip actual spawn
    const claudeCode = runtime.tools.find(t => t.name === 'claude_code');
    claudeCode.execute = async () => ({ ok: true, content: 'mock output' });

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go',
      metadata: { allowExternalAiTools: true }
    });

    await runtime.runSession(session.id);
    const approvals = runtime.listApprovals();
    assert.equal(approvals.length, 1);
    await runtime.approve(approvals[0].id, 'approved');

    await runtime.runSession(session.id);
    const messages = runtime.store.listMessages(session.id);
    const toolMsg = messages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(toolMsg.parts[0].type, 'tool_result');
    assert.equal(toolMsg.parts[0].name, 'claude_code');
    assert.equal(toolMsg.parts[0].isExternal, true);
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

test('external AI tools: non-opted-in session emitting external tool call does not create approval', async () => {
  // Gate is ON but session has NOT opted in
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    const runtime = runtimeWithAdapter(new ScriptedAdapter(() => {
      // Model emits claude_code even though it wasn't in the tool list
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: 'call_sneaky',
          name: 'claude_code',
          input: { prompt: 'do something' }
        }]
      };
    }));

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go'
      // No allowExternalAiTools: true
    });

    await runtime.runSession(session.id);

    // Should NOT create an approval - tool should be rejected as unavailable
    const approvals = runtime.listApprovals();
    assert.equal(approvals.length, 0, 'no approval should be created for external tool in non-opted-in session');

    // Tool result should indicate it's not available
    const messages = runtime.store.listMessages(session.id);
    const toolMsg = messages.find(m => m.role === 'tool');
    assert.ok(toolMsg, 'tool message should exist');
    assert.equal(toolMsg.parts[0].type, 'tool_result');
    assert.equal(toolMsg.parts[0].name, 'claude_code');
    assert.equal(toolMsg.parts[0].ok, false);
    assert.ok(toolMsg.parts[0].content.includes('not available'), 'error message should indicate tool not available');
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

test('external AI tools: repeated call requires approval each time', async () => {
  process.env.RAW_AGENT_EXTERNAL_AI_TOOLS = '1';
  try {
    let emitCount = 0;
    const runtime = runtimeWithAdapter(new ScriptedAdapter((input) => {
      // Count how many tool_results we have for claude_code
      const toolResults = input.messages.flatMap(m => m.parts.filter(p => p.type === 'tool_result' && p.name === 'claude_code'));

      // If we have 2 results, we're done
      if (toolResults.length >= 2) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      }

      // Model always emits the same tool call (same input = same idempotency key)
      emitCount++;
      return {
        stopReason: 'tool_use',
        assistantParts: [{
          type: 'tool_call',
          toolCallId: `call_${emitCount}`,
          name: 'claude_code',
          input: { prompt: 'same prompt' } // Same input = same idempotency key
        }]
      };
    }));

    // Mock execute to skip actual spawn
    const claudeCode = runtime.tools.find(t => t.name === 'claude_code');
    claudeCode.execute = async () => ({ ok: true, content: 'mock output' });

    const session = runtime.createChatSession({
      title: 'test',
      message: 'go',
      metadata: { allowExternalAiTools: true }
    });

    // First call - should require approval
    await runtime.runSession(session.id);
    let approvals = runtime.listApprovals();
    assert.equal(approvals.length, 1, 'first call should require approval');
    await runtime.approve(approvals[0].id, 'approved');

    // Execute first call
    await runtime.runSession(session.id);

    // Second call with same input - should STILL require approval
    await runtime.runSession(session.id);
    approvals = runtime.listApprovals('pending');
    assert.equal(approvals.length, 1, 'second identical call should still require approval');

    // Approve and execute second call
    await runtime.approve(approvals[0].id, 'approved');
    await runtime.runSession(session.id);

    // Verify both calls executed
    const messages = runtime.store.listMessages(session.id);
    const toolResults = messages.filter(m => m.role === 'tool');
    assert.equal(toolResults.length, 2, 'both calls should have executed');
  } finally {
    delete process.env.RAW_AGENT_EXTERNAL_AI_TOOLS;
  }
});

// ─── Prompt-cache regression tests ──────────────────────────────────────────

test('system prompt has stable prefix and dynamic suffix separated by ---', async () => {
  let capturedSystem = '';
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      capturedSystem = input.systemPrompt;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'cache-test', message: 'hello' });
  await runtime.runSession(session.id);

  assert.ok(capturedSystem.includes('---'), 'separator between stable prefix and dynamic context');
  const [stablePrefix] = capturedSystem.split('\n\n---\n\n');
  assert.ok(stablePrefix.includes('You are'), 'stable prefix has agent identity');
  assert.ok(stablePrefix.includes('Repository root:'), 'stable prefix has repo root');
  // Todos, summary, memory are NOT in the stable prefix
  assert.ok(!stablePrefix.includes('Todos:'), 'todos live in dynamic context, not stable prefix');
  assert.ok(!stablePrefix.includes('Handoff scratch'), 'memory lives in dynamic context, not stable prefix');
  assert.ok(!stablePrefix.includes('Compressed summary'), 'summary lives in dynamic context, not stable prefix');
});

test('stable prefix hash stays constant across two turns when only user message changes', async () => {
  const capturedSystems = [];
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      capturedSystems.push(input.systemPrompt);
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'reply' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'hash-test', message: 'first message' });

  await runtime.runSession(session.id);

  // Second turn — only the user message changes
  runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'second message' }]);
  await runtime.runSession(session.id);

  assert.ok(capturedSystems.length >= 2, 'adapter called at least twice');

  // Extract stable prefix from each captured system prompt
  const prefix1 = capturedSystems[0].split('\n\n---\n\n')[0];
  const prefix2 = capturedSystems[1].split('\n\n---\n\n')[0];

  assert.ok(prefix1 && prefix2, 'both turns produced a stable prefix');
  assert.equal(prefix1, prefix2, 'stable prefix is identical across turns when only user message changes');
});

test('summary replace is visible in fold; covered range is not; WAL remains', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'summary-replace', message: 'test' });
  const firstUser = runtime.store.listMessages(session.id).find((m) => m.role === 'user');
  assert.ok(firstUser?.seq, 'appended user message has seq');

  await runtime.runSession(session.id);
  const walBefore = runtime.store.listMessages(session.id);
  const last = walBefore[walBefore.length - 1];
  runtime.store.appendReplacement(session.id, {
    startSeq: firstUser.seq,
    endSeq: last.seq,
    role: 'system',
    parts: [{ type: 'text', text: 'This is a test summary from compaction.' }],
    key: 'compact-summary'
  });

  const wal = runtime.store.listMessages(session.id);
  const folded = runtime.store.foldMessages(session.id);
  assert.ok(wal.length >= walBefore.length + 1, 'WAL still contains original rows plus replace');
  assert.ok(
    wal.some((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'test')),
    'original user message remains in WAL'
  );
  assert.ok(
    folded.some(
      (m) => m.role === 'system' && m.parts.some((p) => p.type === 'text' && p.text.includes('This is a test summary'))
    ),
    'summary replace node is visible in fold'
  );
  assert.ok(
    !folded.some((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'test')),
    'covered range is not visible in fold'
  );
});

test('summary from compaction appears in system prompt dynamic context only', async () => {
  let capturedSystem = '';
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      capturedSystem = input.systemPrompt;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'summary-system', message: 'test' });
  runtime.store.updateSession(session.id, { summary: 'Previous context: user was debugging a parser.' });

  await runtime.runSession(session.id);

  assert.ok(capturedSystem.includes('Compressed summary:'), 'summary in system prompt dynamic section');
  assert.ok(capturedSystem.includes('Previous context: user was debugging a parser.'), 'summary content present');
  // It must be AFTER the separator (dynamic context, not stable prefix)
  const parts = capturedSystem.split('\n\n---\n\n');
  assert.ok(parts.length >= 2, 'separator present');
  assert.ok(!parts[0].includes('Compressed summary'), 'summary NOT in stable prefix');
  assert.ok(parts[1].includes('Compressed summary'), 'summary in dynamic context');
});

test('memory injection is capped at MAX_MEMORY_ENTRIES per scope', async () => {
  let capturedSystem = '';
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter((input) => {
      capturedSystem = input.systemPrompt;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    })
  );
  const session = runtime.createChatSession({ title: 'mem-cap', message: 'x' });
  // Insert 25 scratch entries (over cap of 20)
  for (let i = 0; i < 25; i++) {
    runtime.store.upsertSessionMemory({ sessionId: session.id, scope: 'scratch', key: `k${i}`, value: `v${i}` });
  }
  await runtime.runSession(session.id);

  const dynamicPart = capturedSystem.split('\n\n---\n\n')[1] ?? '';
  // Count how many scratch key entries appear
  const matches = (dynamicPart.match(/^- k\d+:/mg) ?? []).length;
  assert.ok(matches <= 20, `at most 20 memory entries injected, got ${matches}`);
});


test('runSession throws NotFoundError for missing session', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'ok' }]
    }))
  );
  await assert.rejects(
    () => runtime.runSession('nonexistent-session'),
    (err) => err instanceof NotFoundError
  );
});

test('sendUserMessage throws NotFoundError for missing session', () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'ok' }]
    }))
  );
  assert.throws(
    () => runtime.sendUserMessage('nonexistent-session', 'hello'),
    (err) => err instanceof NotFoundError
  );
});

test('sendUserMessage throws ValidationError for empty message without images', () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'ok' }]
    }))
  );
  runtime.store.upsertAgent({ id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] });
  const session = runtime.store.createSession({ title: 'test', mode: 'chat', agentId: 'general' });
  assert.throws(
    () => runtime.sendUserMessage(session.id, '  '),
    (err) => err instanceof ValidationError
  );
});

test('concurrent runSession calls on same session return same promise', async () => {
  let callCount = 0;
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'ok' }]
      };
    })
  );
  runtime.store.upsertAgent({ id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] });
  const session = runtime.store.createSession({ title: 'test', mode: 'chat', agentId: 'general' });
  runtime.sendUserMessage(session.id, 'hello');

  const [r1, r2] = await Promise.all([
    runtime.runSession(session.id),
    runtime.runSession(session.id)
  ]);
  assert.equal(r1.id, r2.id);
  // Model should only be called once despite two runSession calls
  assert.equal(callCount, 1);
});

test('destroy() cleans up without errors', async () => {
  const runtime = runtimeWithAdapter(
    new ScriptedAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'ok' }]
    }))
  );
  // Should not throw
  await runtime.destroy();
});

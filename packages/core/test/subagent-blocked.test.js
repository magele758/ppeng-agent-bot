import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

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

function makeRuntime(childBehavior) {
  const adapter = new ScriptedAdapter((input) => {
    if (input.agent.id === 'researcher') {
      if (childBehavior === 'bash') {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'child_bash',
              name: 'bash',
              input: { command: 'rm -rf /tmp/subagent-blocked-example' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'sub done' }] };
    }
    const spawned = input.messages.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.name === 'spawn_subagent')
    );
    if (!spawned) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'spawn1',
            name: 'spawn_subagent',
            input: { prompt: 'Do the thing.', role: 'research' }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
  });
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'sub-blocked-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'sub-blocked-state-')),
    modelAdapter: adapter
  });
}

function spawnResult(runtime, sessionId) {
  const part = runtime
    .getSessionMessages(sessionId)
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool_result' && p.name === 'spawn_subagent');
  assert.ok(part, 'spawn_subagent tool_result is paired with the tool_call');
  return part;
}

function childOf(runtime, parentId) {
  const child = runtime.store.listSessions().find((s) => s.parentSessionId === parentId);
  assert.ok(child);
  return child;
}

function assertBlocked(runtime, parentId) {
  const part = spawnResult(runtime, parentId);
  const child = childOf(runtime, parentId);
  assert.equal(part.ok, false);
  const body = JSON.parse(part.content);
  assert.equal(body.blocked, true);
  assert.equal(body.status, 'waiting_approval');
  assert.equal(body.childSessionId, child.id);
  assert.deepEqual(body.blockedTools, ['bash']);
  const pending = runtime.store
    .listApprovals({ status: 'pending' })
    .filter((a) => a.sessionId === child.id);
  assert.equal(pending.length, 1);
  assert.deepEqual(body.approvalIds, [pending[0].id]);
  assert.equal(body.approvals[0].tool, 'bash');
  assert.match(body.remediation, /approv/i);
  assert.equal(child.status, 'waiting_approval');
  assert.equal(child.metadata.permissionMode !== undefined, true);
  return { body, child };
}

test('bot parent (auto): inherited auto still parks high-risk bash with approval id [AC:bot-task-permission-inheritance#AC-1]', async () => {
  const runtime = makeRuntime('bash');
  const parent = runtime.createChatSession({
    title: 'bot parent',
    message: 'go',
    metadata: { canonicalBotChat: true, botId: 'probe', permissionMode: 'auto' }
  });
  await runtime.runSession(parent.id);
  const { child } = assertBlocked(runtime, parent.id);
  assert.equal(child.metadata.permissionMode, 'auto');
  assert.equal(runtime.getLatestAssistantText(parent.id), 'parent done');
});

test('non-bot parent in ask (spawn pre-approved): a blocked subagent is reported the same way', async () => {
  const runtime = makeRuntime('bash');
  const parent = runtime.createChatSession({
    title: 'plain parent',
    message: 'go',
    metadata: { permissionMode: 'ask' }
  });
  const first = await runtime.runSession(parent.id);
  assert.equal(first.status, 'waiting_approval');
  const [spawnApproval] = runtime.listApprovals().filter((a) => a.sessionId === parent.id);
  assert.equal(spawnApproval.toolName, 'spawn_subagent');
  await runtime.approve(spawnApproval.id, 'approved');
  await runtime.runSession(parent.id);
  const { child } = assertBlocked(runtime, parent.id);
  assert.equal(child.metadata.permissionMode, 'ask');
});

test('non-bot parent in auto: a high-risk child tool is parked and reported the same way', async () => {
  const runtime = makeRuntime('bash');
  const parent = runtime.createChatSession({
    title: 'plain auto parent',
    message: 'go',
    metadata: { permissionMode: 'auto' }
  });
  await runtime.runSession(parent.id);
  const { child } = assertBlocked(runtime, parent.id);
  assert.equal(child.metadata.permissionMode, 'auto');
  assert.equal(runtime.getLatestAssistantText(parent.id), 'parent done');
});

test('a subagent that finishes normally keeps the plain ok result', async () => {
  for (const metadata of [
    { permissionMode: 'auto' },
    { canonicalBotChat: true, botId: 'probe', permissionMode: 'auto' }
  ]) {
    const runtime = makeRuntime('text');
    const parent = runtime.createChatSession({ title: 'fine', message: 'go', metadata });
    await runtime.runSession(parent.id);
    const part = spawnResult(runtime, parent.id);
    assert.equal(part.ok, true);
    assert.match(part.content, /sub done/);
    assert.throws(() => JSON.parse(part.content));
    assert.equal(childOf(runtime, parent.id).status, 'idle');
  }
});

test('teammate parked on approval stays visible through session status, outcome metadata and the approvals list', async () => {
  const adapter = new ScriptedAdapter((input) => {
    if (input.agent.id === 'mate') {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'mate_bash',
            name: 'bash',
            input: { command: 'rm -rf /tmp/subagent-blocked-example' }
          }
        ]
      };
    }
    const spawned = input.messages.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.name === 'spawn_teammate')
    );
    if (!spawned) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'mate1',
            name: 'spawn_teammate',
            input: { name: 'mate', role: 'helper', prompt: 'work' }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
  });
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'mate-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'mate-state-')),
    modelAdapter: adapter
  });
  const parent = runtime.createChatSession({
    title: 'mate parent',
    message: 'go',
    metadata: { permissionMode: 'auto' }
  });
  await runtime.runSession(parent.id);
  const mate = childOf(runtime, parent.id);
  assert.equal(mate.status, 'waiting_approval');
  assert.ok(mate.metadata.runOutcome ?? mate.metadata.outcome, 'outcome metadata is recorded');
  assert.equal(
    runtime.store.listApprovals({ status: 'pending' }).filter((a) => a.sessionId === mate.id).length,
    1
  );
});

function makeTeammateRuntime(mateBehavior) {
  const adapter = new ScriptedAdapter((input) => {
    if (input.agent.id === 'mate') {
      if (mateBehavior === 'bash') {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'mate_bash',
              name: 'bash',
              input: { command: 'rm -rf /tmp/subagent-blocked-example' }
            }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'mate ready' }] };
    }
    const spawned = input.messages.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.name === 'spawn_teammate')
    );
    if (!spawned) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'mate1',
            name: 'spawn_teammate',
            input: { name: 'mate', role: 'helper', prompt: 'work' }
          }
        ]
      };
    }
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'parent done' }] };
  });
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'mate2-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'mate2-state-')),
    modelAdapter: adapter
  });
}

function teammateResult(runtime, parentId) {
  const part = runtime
    .getSessionMessages(parentId)
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool_result' && p.name === 'spawn_teammate');
  assert.ok(part, 'spawn_teammate tool_result is paired with the tool_call');
  return part;
}

test('teammate parked on approval: spawn_teammate result names the blocked tool, approval id, session and remediation', async () => {
  const runtime = makeTeammateRuntime('bash');
  const parent = runtime.createChatSession({
    title: 'mate parent',
    message: 'go',
    metadata: { permissionMode: 'auto' }
  });
  await runtime.runSession(parent.id);
  const mate = childOf(runtime, parent.id);
  assert.equal(mate.status, 'waiting_approval');
  const part = teammateResult(runtime, parent.id);
  assert.equal(part.ok, true, 'the teammate exists; only its progress is blocked');
  const body = JSON.parse(part.content);
  const [pending] = runtime.store
    .listApprovals({ status: 'pending' })
    .filter((a) => a.sessionId === mate.id);
  assert.equal(body.blocked, true);
  assert.equal(body.spawned, true);
  assert.equal(body.status, 'waiting_approval');
  assert.equal(body.teammateSessionId, mate.id);
  assert.match(body.message, new RegExp(`Spawned teammate mate in session ${mate.id}`));
  assert.deepEqual(body.blockedTools, ['bash']);
  assert.deepEqual(body.approvalIds, [pending.id]);
  assert.equal(body.approvals[0].tool, 'bash');
  assert.match(body.remediation, /waiting for human approval/);
  assert.match(body.remediation, /\/api\/approvals\/:id\/approve/);
  assert.match(body.remediation, /Do not spawn a duplicate/);
  assert.equal(runtime.getLatestAssistantText(parent.id), 'parent done');
});

test('teammate that finishes its first run keeps the plain spawned text', async () => {
  const runtime = makeTeammateRuntime('text');
  const parent = runtime.createChatSession({
    title: 'mate parent fine',
    message: 'go',
    metadata: { permissionMode: 'auto' }
  });
  await runtime.runSession(parent.id);
  const mate = childOf(runtime, parent.id);
  assert.equal(mate.status, 'idle');
  const part = teammateResult(runtime, parent.id);
  assert.equal(part.ok, true);
  assert.equal(part.content, `Spawned teammate mate in session ${mate.id}`);
});

test('inherited bypass executes a child write without creating an approval [AC:bot-task-permission-inheritance#AC-2]', async () => {
  const { readFileSync } = await import('node:fs');
  const repoRoot = mkdtempSync(join(tmpdir(), 'child-bypass-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir: mkdtempSync(join(tmpdir(), 'child-bypass-state-')),
    modelAdapter: new ScriptedAdapter(input => {
      const child = input.agent.id === 'researcher';
      const tool = child ? 'write_file' : 'spawn_subagent';
      if (input.messages.some(message => message.parts.some(part => part.type === 'tool_result' && part.name === tool))) {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      }
      return { stopReason: 'tool_use', assistantParts: [{ type: 'tool_call', toolCallId: child ? 'write-child' : 'spawn-child', name: tool,
        input: child ? { path: join(repoRoot, 'proof.txt'), content: 'child effect' } : { role: 'research', prompt: 'write proof.txt' } }] };
    })
  });
  try {
    const parent = runtime.createChatSession({ title: 'Bot', message: 'go', metadata: { botId: 'owner', permissionMode: 'bypass' } });
    await runtime.runSession(parent.id);
    assert.equal(spawnResult(runtime, parent.id).ok, true);
    assert.equal(readFileSync(join(repoRoot, 'proof.txt'), 'utf8'), 'child effect');
    assert.deepEqual(runtime.listApprovals(), []);
    assert.equal(childOf(runtime, parent.id).metadata.permissionMode, 'bypass');
  } finally { await runtime.destroy(); }
});

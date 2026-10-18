import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { SqliteStateStore } from '../dist/storage.js';
import { builtinAgents } from '../dist/builtin-agents.js';
import { NotFoundError, ValidationError } from '../dist/errors.js';
import { findToolByName } from '../dist/tools/tool-orchestration.js';
import { McpManager } from '../dist/mcp/mcp-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StubAdapter {
  constructor(handler) {
    this.name = 'stub';
    this.handler = handler ?? (() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'ok' }]
    }));
  }
  async runTurn(input) { return this.handler(input); }
  async summarizeMessages() { return 'summary'; }
}

function makeDirs() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ri-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'ri-state-'));
  return { repoRoot, stateDir };
}

function makeRuntime(overrides) {
  const { repoRoot, stateDir } = makeDirs();
  return new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new StubAdapter(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Tool registration and discovery
// ---------------------------------------------------------------------------

test('runtime initializes with builtin tools when none provided', () => {
  const rt = makeRuntime();
  assert.ok(Array.isArray(rt.tools));
  assert.ok(rt.tools.length > 0, 'should have builtin tools');
  const names = rt.tools.map((t) => t.name);
  assert.ok(names.includes('read_file'), 'builtin read_file should be present');
});

test('custom tools are available via runtime.tools', () => {
  const custom = {
    name: 'my_tool',
    description: 'custom',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: true, content: 'done' }),
  };
  const rt = makeRuntime({ tools: [custom] });
  assert.ok(
    rt.tools.some((t) => t.name === 'my_tool'),
    'custom tool should remain registered'
  );
  // Discovery meta tools are always registered (execute-gated by settings).
  assert.ok(rt.tools.some((t) => t.name === 'tool_search'));
});

test('findToolByName locates tools from runtime.tools', () => {
  const rt = makeRuntime();
  const readFile = findToolByName(rt.tools, 'read_file');
  assert.ok(readFile, 'should find read_file');
  assert.equal(readFile.name, 'read_file');

  const missing = findToolByName(rt.tools, 'does_not_exist');
  assert.equal(missing, undefined);
});

test('tools have required ToolContract properties', () => {
  const rt = makeRuntime();
  for (const tool of rt.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `tool name: ${tool.name}`);
    assert.ok(typeof tool.description === 'string', `desc for ${tool.name}`);
    assert.ok(typeof tool.execute === 'function', `execute for ${tool.name}`);
    assert.ok(tool.inputSchema, `schema for ${tool.name}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Session lifecycle (through Runtime, not just Store)
// ---------------------------------------------------------------------------

test('createChatSession sets defaults and persists', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'Test chat' });
  assert.ok(session.id);
  assert.equal(session.title, 'Test chat');
  assert.equal(session.mode, 'chat');
  assert.equal(session.status, 'idle');
  assert.equal(session.agentId, 'main');

  const fetched = rt.getSession(session.id);
  assert.ok(fetched);
  assert.equal(fetched.id, session.id);
});

test('createChatSession appends user message when provided', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'Hi', message: 'Hello world' });
  const msgs = rt.getSessionMessages(session.id);
  assert.ok(msgs.length >= 1);
  const userMsg = msgs.find((m) => m.role === 'user');
  assert.ok(userMsg, 'should have a user message');
  const textPart = userMsg.parts.find((p) => p.type === 'text');
  assert.ok(textPart);
  assert.ok(textPart.text.includes('Hello world'));
});

test('createChatSession with custom agentId', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'Custom', agentId: 'general' });
  assert.equal(session.agentId, 'general');
});

test('createTaskSession creates linked task and session', () => {
  const rt = makeRuntime();
  const { task, session } = rt.createTaskSession({
    title: 'Feature X',
    description: 'Implement feature X',
  });
  assert.ok(task.id);
  assert.ok(session.id);
  assert.equal(session.mode, 'task');
  assert.equal(task.title, 'Feature X');

  const fetchedTask = rt.getTask(task.id);
  assert.ok(fetchedTask);
  assert.equal(fetchedTask.sessionId, session.id);
});

test('session status transitions through runSession', async () => {
  const rt = makeRuntime({
    modelAdapter: new StubAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'done' }],
    })),
  });
  const session = rt.createChatSession({ title: 'Status test', message: 'go' });
  assert.equal(session.status, 'idle');
  const after = await rt.runSession(session.id);
  assert.equal(after.status, 'idle');
});

test('listSessions returns all created sessions', () => {
  const rt = makeRuntime();
  rt.createChatSession({ title: 'A' });
  rt.createChatSession({ title: 'B' });
  const sessions = rt.listSessions();
  assert.ok(sessions.length >= 2);
});

// ---------------------------------------------------------------------------
// 3. Builtin agents sync
// ---------------------------------------------------------------------------

test('ensureBuiltinAgentsSynced populates agents in store', () => {
  const rt = makeRuntime();
  rt.ensureBuiltinAgentsSynced();
  const agents = rt.listAgents();
  assert.ok(agents.length >= builtinAgents.length, 'at least all builtin agents should exist');
  for (const ba of builtinAgents) {
    const found = agents.find((a) => a.id === ba.id);
    assert.ok(found, `builtin agent "${ba.id}" should be in store`);
    assert.equal(found.name, ba.name);
  }
});

test('ensureBuiltinAgentsSynced is idempotent', () => {
  const rt = makeRuntime();
  rt.ensureBuiltinAgentsSynced();
  const before = rt.listAgents().length;
  rt.ensureBuiltinAgentsSynced();
  rt.ensureBuiltinAgentsSynced();
  assert.equal(rt.listAgents().length, before, 'count should not change on repeated calls');
});

test('builtin agents include general and main', () => {
  const rt = makeRuntime();
  rt.ensureBuiltinAgentsSynced();
  const agents = rt.listAgents();
  const ids = agents.map((a) => a.id);
  assert.ok(ids.includes('general'), 'should have general agent');
  assert.ok(ids.includes('main'), 'should have main agent');
});

// ---------------------------------------------------------------------------
// 4. McpManager integration
// ---------------------------------------------------------------------------

test('McpManager can be constructed standalone without crashing', () => {
  const { stateDir } = makeDirs();
  const mgr = new McpManager({
    stateDir,
    tools: [],
    env: {},
    log: { warn: () => {} },
  });
  assert.ok(mgr);
});

test('McpManager destroy on fresh instance is safe', async () => {
  const { stateDir } = makeDirs();
  const mgr = new McpManager({
    stateDir,
    tools: [],
    env: {},
    log: { warn: () => {} },
  });
  await mgr.destroy();
});

test('runtime destroy cleans up mcpManager and background state', async () => {
  const rt = makeRuntime();
  rt.createChatSession({ title: 'will destroy' });
  await rt.destroy();
  // Should not throw on second destroy
  await rt.destroy();
});

// ---------------------------------------------------------------------------
// 5. Storage integration through runtime
// ---------------------------------------------------------------------------

test('SqliteStateStore standalone: create and retrieve session', () => {
  const { stateDir } = makeDirs();
  const store = new SqliteStateStore(join(stateDir, 'test.sqlite'));
  store.upsertAgent({ id: 'a1', name: 'A1', role: 'r', instructions: 'i', capabilities: [] });

  const session = store.createSession({
    title: 'Direct',
    mode: 'chat',
    agentId: 'a1',
    background: false,
  });
  assert.ok(session.id);
  const fetched = store.getSession(session.id);
  assert.ok(fetched);
  assert.equal(fetched.title, 'Direct');
});

test('SqliteStateStore: agent upsert updates existing', () => {
  const { stateDir } = makeDirs();
  const store = new SqliteStateStore(join(stateDir, 'test.sqlite'));
  store.upsertAgent({ id: 'x', name: 'X1', role: 'r1', instructions: 'i1', capabilities: ['a'] });
  store.upsertAgent({ id: 'x', name: 'X2', role: 'r2', instructions: 'i2', capabilities: ['b'] });
  const agent = store.getAgent('x');
  assert.equal(agent.name, 'X2');
  assert.equal(agent.role, 'r2');
});

test('SqliteStateStore: session messages round-trip', () => {
  const { stateDir } = makeDirs();
  const store = new SqliteStateStore(join(stateDir, 'test.sqlite'));
  store.upsertAgent({ id: 'a', name: 'A', role: 'r', instructions: '', capabilities: [] });
  const session = store.createSession({ title: 'Msg test', mode: 'chat', agentId: 'a', background: false });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hello' }]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'hi back' }]);
  const msgs = store.listMessages(session.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
});

// ---------------------------------------------------------------------------
// 6. Error propagation
// ---------------------------------------------------------------------------

test('runSession with non-existent ID throws NotFoundError', async () => {
  const rt = makeRuntime();
  await assert.rejects(
    () => rt.runSession('nonexistent-session-id'),
    (err) => {
      assert.ok(err instanceof NotFoundError);
      return true;
    },
  );
});

test('sendUserMessage with non-existent session throws NotFoundError', () => {
  const rt = makeRuntime();
  assert.throws(
    () => rt.sendUserMessage('no-such-session', 'hello'),
    (err) => err instanceof NotFoundError,
  );
});

test('sendUserMessage with empty text and no images throws ValidationError', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'V' });
  assert.throws(
    () => rt.sendUserMessage(session.id, '  '),
    (err) => err instanceof ValidationError,
  );
});

// ---------------------------------------------------------------------------
// 7. Cross-component: session + message + assistant text
// ---------------------------------------------------------------------------

test('getLatestAssistantText returns last assistant reply', async () => {
  const rt = makeRuntime({
    modelAdapter: new StubAdapter(() => ({
      stopReason: 'end',
      assistantParts: [{ type: 'text', text: 'Integration reply' }],
    })),
  });
  const session = rt.createChatSession({ title: 'Reply', message: 'ping' });
  await rt.runSession(session.id);
  const text = rt.getLatestAssistantText(session.id);
  assert.equal(text, 'Integration reply');
});

test('getLatestAssistantText returns undefined for session with no assistant message', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'Empty' });
  const text = rt.getLatestAssistantText(session.id);
  assert.equal(text, undefined);
});

// ---------------------------------------------------------------------------
// 8. Teammate and mailbox integration
// ---------------------------------------------------------------------------

test('createTeammateSession creates agent and session', () => {
  const rt = makeRuntime();
  const session = rt.createTeammateSession({
    name: 'Researcher',
    role: 'Research tasks',
    prompt: 'Find information',
  });
  assert.ok(session.id);
  assert.equal(session.mode, 'teammate');
  const agent = rt.listAgents().find((a) => a.id === 'Researcher');
  assert.ok(agent, 'teammate agent should be registered');
});

test('sendMailboxMessage and list roundtrip', () => {
  const rt = makeRuntime();
  rt.createTeammateSession({ name: 'Worker', role: 'work', prompt: 'do things' });
  const mail = rt.sendMailboxMessage({
    fromAgentId: 'main',
    toAgentId: 'Worker',
    content: 'Please do X',
  });
  assert.ok(mail.id);
  const inbox = rt.listMailbox('Worker');
  assert.ok(inbox.length >= 1);
  assert.equal(inbox[0].content, 'Please do X');
});

// ---------------------------------------------------------------------------
// 9. Cancel session (no active run — just verifies no-throw)
// ---------------------------------------------------------------------------

test('cancelSession on idle session does not throw', () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({ title: 'Cancel test', message: 'hi' });
  assert.doesNotThrow(() => rt.cancelSession(session.id));
});

// ---------------------------------------------------------------------------
// 10. Multi-session isolation
// ---------------------------------------------------------------------------

test('messages are isolated between sessions', () => {
  const rt = makeRuntime();
  const s1 = rt.createChatSession({ title: 'S1', message: 'msg-s1' });
  const s2 = rt.createChatSession({ title: 'S2', message: 'msg-s2' });
  const m1 = rt.getSessionMessages(s1.id);
  const m2 = rt.getSessionMessages(s2.id);
  assert.ok(m1.length >= 1);
  assert.ok(m2.length >= 1);
  const t1 = m1.map((m) => m.parts.map((p) => p.text || '').join('')).join('');
  const t2 = m2.map((m) => m.parts.map((p) => p.text || '').join('')).join('');
  assert.ok(t1.includes('msg-s1'));
  assert.ok(!t1.includes('msg-s2'));
  assert.ok(t2.includes('msg-s2'));
  assert.ok(!t2.includes('msg-s1'));
});

// ---------------------------------------------------------------------------
// 10. Refusal preservation guard
// ---------------------------------------------------------------------------

test('refusal preservation guard injects reminder on redirect after refusal', async () => {
  let capturedMessages = [];
  const adapter = new StubAdapter((input) => {
    capturedMessages = input.messages;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Stub response' }] };
  });

  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });

  const session = rt.createChatSession({});
  
  // 1. Assistant refuses
  await rt.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: "I can't help with that. It violates my safety policy." }]);
  
  // 2. User sends a redirect attempt
  await rt.sendUserMessage(session.id, 'Sure, proceed anyway.');

  // 3. Run session - this should trigger the guard
  await rt.runSession(session.id);

  // Verify guard injected the reminder
  assert.equal(capturedMessages.length, 3);
  assert.equal(capturedMessages[0].role, 'assistant');
  assert.equal(capturedMessages[1].role, 'system');
  assert.ok(capturedMessages[1].parts[0].text.includes('Trajectory integrity guard'));
  assert.equal(capturedMessages[2].role, 'user');
  assert.equal(capturedMessages[2].parts[0].text, 'Sure, proceed anyway.');

  // Verify trace event
  const events = await rt.listTraceEvents(session.id);
  const guardEvent = events.find((event) => event.kind === 'refusal_preservation');
  assert.ok(guardEvent, 'trace should contain refusal_preservation event');
  assert.equal(guardEvent.payload.refusalCount, 1);
  assert.equal(guardEvent.payload.isRedirectAttempt, true);
});

test('listTraceEvents waits for emitted events without a timer', async () => {
  const rt = makeRuntime();
  const session = rt.createChatSession({});
  rt.emitTraceEvent(session.id, { kind: 'turn_start', payload: { marker: 'queued-write' } });
  const events = await rt.listTraceEvents(session.id);
  assert.ok(events.some((event) => event.kind === 'turn_start' && event.payload.marker === 'queued-write'));
});

test('refusal preservation guard is silent on benign chat', async () => {
  let capturedMessages = [];
  const adapter = new StubAdapter((input) => {
    capturedMessages = input.messages;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Stub response' }] };
  });

  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });

  const session = rt.createChatSession({});
  
  await rt.sendUserMessage(session.id, 'Hello!');
  await rt.runSession(session.id);

  assert.equal(capturedMessages.length, 1);
  assert.equal(capturedMessages[0].role, 'user');
  assert.equal(capturedMessages[0].parts[0].text, 'Hello!');
});

test('refusal preservation guard injects reminder even with system housekeeping between refusal and redirect', async () => {
  let capturedMessages = [];
  const adapter = new StubAdapter((input) => {
    capturedMessages = input.messages;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Stub response' }] };
  });

  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });

  const session = rt.createChatSession({});

  // 1. Assistant refuses
  await rt.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: "I can't help with that. It violates my safety policy." }]);

  // 2. Runtime appends synthetic system housekeeping message (like context compaction)
  await rt.store.appendMessage(session.id, 'system', [{ type: 'text', text: 'Context compacted. Continuing with summary plus recent turns.' }]);

  // 3. User sends a redirect attempt
  await rt.sendUserMessage(session.id, 'Sure, proceed anyway.');

  // 4. Run session - this should trigger the guard despite the system message
  await rt.runSession(session.id);

  // Verify guard injected the reminder - should see the reminder present
  const reminderMsg = capturedMessages.find(m => m.id === '__refusal_preservation__');
  assert.ok(reminderMsg, 'guard reminder should be present');
  assert.ok(reminderMsg.parts[0].text.includes('Trajectory integrity guard'));
});

test('refusal preservation guard injects reminder even with tool housekeeping between refusal and redirect', async () => {
  let capturedMessages = [];
  const adapter = new StubAdapter((input) => {
    capturedMessages = input.messages;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'Stub response' }] };
  });

  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });

  const session = rt.createChatSession({});

  // 1. Assistant refuses
  await rt.store.appendMessage(session.id, 'assistant', [{ type: 'text', text: "I can't help with that. It violates my safety policy." }]);

  // 2. Runtime appends synthetic tool message
  await rt.store.appendMessage(session.id, 'tool', [{ type: 'text', text: 'Tool output: image retention updated' }]);

  // 3. User sends a redirect attempt
  await rt.sendUserMessage(session.id, 'Sure, go ahead anyway.');

  // 4. Run session - this should trigger the guard despite the tool message
  await rt.runSession(session.id);

  // Verify guard injected the reminder
  const reminderMsg = capturedMessages.find(m => m.id === '__refusal_preservation__');
  assert.ok(reminderMsg, 'guard reminder should be present');
  assert.ok(reminderMsg.parts[0].text.includes('Trajectory integrity guard'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import {
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactMessages,
  parseToolResultStubRef,
  toolResultPlaceholder
} from '../dist/session/micro-compact.js';
import {
  retrieveSessionToolResult,
  retrieveStoredToolResult
} from '../dist/session/tool-result-retrieve.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { applyPermissionModeGate } from '../dist/approval/permission-mode.js';
import { NotFoundError } from '../dist/errors.js';

const SECRET = 'UNIQUE_TOOL_PAYLOAD_9f3a_do_not_echo_in_stub';

function toolMsg(id, name, content, ok = true, extra = {}) {
  return {
    id,
    sessionId: extra.sessionId ?? 's1',
    role: 'tool',
    seq: extra.seq,
    parts: [{ type: 'tool_result', toolCallId: extra.toolCallId ?? `c-${id}`, name, ok, content }],
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function stubServices(overrides = {}) {
  return {
    loadSkill: async () => ({ content: '' }),
    updateTodo: async () => [],
    createTask: async () => ({}),
    getTask: async () => undefined,
    listTasks: async () => [],
    updateTask: async () => ({}),
    harnessWriteSpec: async () => '',
    spawnSubagent: async () => '',
    spawnTeammate: async () => '',
    listAgents: async () => [],
    sendMail: async () => ({}),
    readInbox: async () => [],
    startBackgroundJob: async () => ({}),
    getBackgroundJob: async () => undefined,
    listBackgroundJobs: async () => [],
    listWorkspaces: async () => [],
    upsertSessionMemory: async () => ({}),
    listSessionMemory: async () => [],
    deleteSessionMemory: async () => true,
    visionAnalyze: async () => '',
    ...overrides
  };
}

test('placeholder keeps prefix and adds a stable message/part address', () => {
  const text = toolResultPlaceholder('bash', true, { messageId: 'msg_abc', partIndex: 0, seq: 4 });
  assert.match(text, /^\[previous: used bash — earlier tool output was omitted to save space\]/);
  assert.match(text, /\bmsg=msg_abc\b/);
  assert.match(text, /\bpart=0\b/);
  assert.match(text, /\bseq=4\b/);
  assert.deepEqual(parseToolResultStubRef(text), { messageId: 'msg_abc', partIndex: 0, seq: 4 });
});

test('failed placeholder still matches old assertions and parses', () => {
  const text = toolResultPlaceholder('grep', false, { messageId: 't9', partIndex: 1 });
  assert.match(text, /\[previous: used grep \(failed\) — earlier tool output was omitted to save space\]/);
  assert.equal(parseToolResultStubRef(text)?.messageId, 't9');
  assert.equal(parseToolResultStubRef(text)?.partIndex, 1);
});

test('collapsed model view drops full text; retrieve returns the same stored payload', () => {
  const stored = [
    toolMsg('old', 'bash', `${SECRET}${'x'.repeat(200)}`, true, { seq: 2 }),
    toolMsg('keep-a', 'bash', 'recent-a'.padEnd(40, '!')),
    toolMsg('keep-b', 'bash', 'recent-b'.padEnd(40, '!'))
  ];
  const { messages: modelView, stats } = microCompactMessages(stored, {
    ...DEFAULT_MICRO_COMPACT_CONFIG,
    keepRecent: 2,
    minChars: 10
  });

  assert.equal(stats.collapsed, 1);
  const stub = modelView[0].parts[0].content;
  assert.match(stub, /\[previous: used bash/);
  assert.match(stub, /earlier tool output was omitted to save space/);
  assert.equal(stub.includes(SECRET), false, 'model view must not keep the stored payload');
  assert.ok(stored[0].parts[0].content.includes(SECRET), 'stored transcript stays intact');

  const ref = parseToolResultStubRef(stub);
  assert.ok(ref, 'stub must carry a parseable address');
  assert.equal(ref.messageId, 'old');
  assert.equal(ref.partIndex, 0);

  const got = retrieveStoredToolResult(stored, ref);
  assert.ok(got);
  assert.equal(got.content, stored[0].parts[0].content);
  assert.equal(got.name, 'bash');
  assert.equal(got.ok, true);
  assert.equal(got.messageId, 'old');
});

test('retrieveSessionToolResult is scoped to the requested session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-result-retrieve-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  store.upsertAgent({
    id: 'general',
    name: 'General',
    role: 'assistant',
    instructions: 'x',
    capabilities: []
  });
  const a = store.createSession({ title: 'A', mode: 'chat', agentId: 'general' });
  const b = store.createSession({ title: 'B', mode: 'chat', agentId: 'general' });
  const payload = `session-a-only ${SECRET}`;
  const tool = store.appendMessage(a.id, 'tool', [
    { type: 'tool_result', toolCallId: 'c1', name: 'bash', ok: true, content: payload }
  ]);

  const same = retrieveSessionToolResult(store, a.id, { messageId: tool.id, partIndex: 0 });
  assert.equal(same.content, payload);

  assert.throws(
    () => retrieveSessionToolResult(store, b.id, { messageId: tool.id, partIndex: 0 }),
    (err) => err instanceof NotFoundError
  );
  assert.throws(
    () => retrieveSessionToolResult(store, 'missing', { messageId: tool.id }),
    (err) => err instanceof NotFoundError
  );

  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('retrieve_tool_result tool only reads the current session and returns stored text', async () => {
  const own = toolMsg('mine', 'bash', SECRET, true, { sessionId: 'sess-own' });
  const other = toolMsg('theirs', 'bash', 'other-session-secret', true, { sessionId: 'sess-other' });
  const tools = createBuiltinTools(
    stubServices({
      listSessionMessages: (sessionId) => (sessionId === 'sess-own' ? [own] : sessionId === 'sess-other' ? [other] : [])
    })
  );
  const tool = tools.find((t) => t.name === 'retrieve_tool_result');
  assert.ok(tool, 'retrieve_tool_result must be registered');
  assert.equal(tool.approvalMode, 'never');
  assert.equal(tool.sideEffectLevel, 'none');

  const ctx = {
    repoRoot: process.cwd(),
    stateDir: process.cwd(),
    agent: { id: 'a' },
    session: { id: 'sess-own' }
  };

  const ok = await tool.execute(ctx, { message_id: 'mine' });
  assert.equal(ok.ok, true);
  assert.equal(ok.content, SECRET);

  const fromStub = await tool.execute(ctx, {
    stub: toolResultPlaceholder('bash', true, { messageId: 'mine', partIndex: 0 })
  });
  assert.equal(fromStub.ok, true);
  assert.equal(fromStub.content, SECRET);

  const leaked = await tool.execute(ctx, { message_id: 'theirs' });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.content.includes('other-session-secret'), false);

  const foreignCtx = { ...ctx, session: { id: 'sess-other' } };
  const cross = await tool.execute(foreignCtx, { message_id: 'mine' });
  assert.equal(cross.ok, false);
  assert.equal(cross.content.includes(SECRET), false);
});

test('plan mode allows retrieve_tool_result as read-only', () => {
  assert.deepEqual(applyPermissionModeGate('plan', 'retrieve_tool_result', 'never'), { action: 'proceed' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { SourceLedger } from '../dist/learning/sources.js';
import { executeSingleTool, checkToolApprovals } from '../dist/runtime/tool-loop.js';
import { commandHardlineToolResult } from '../dist/sandbox/command-hardline.js';
import { sensitiveReadRefusal } from '../dist/workspace/sensitive-read.js';
import { StepInboxStore } from '../dist/session/step-inbox.js';

const GH = 'gh repo list --limit 20';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'group-scope-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

function openSession(store, metadata) {
  return store.createSession({
    agentId: 'general',
    title: 'bot',
    mode: 'chat',
    metadata: { userId: 'alice', botId: 'super', ...metadata }
  });
}

function say(store, session, text) {
  return store.appendMessage(session.id, 'user', [{ type: 'text', text }]);
}

function bashTool(ran) {
  return {
    name: 'bash',
    description: 'bash',
    inputSchema: { type: 'object' },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval(_context, args) {
      return String(args.command ?? '').includes('rm ');
    },
    async execute(_context, args) {
      const denied = commandHardlineToolResult(String(args.command ?? ''));
      if (denied) return denied;
      ran.push(String(args.command ?? ''));
      return { ok: true, content: `ok:${args.command}` };
    }
  };
}

function readTool(ran) {
  return {
    name: 'read_file',
    description: 'read',
    inputSchema: { type: 'object' },
    approvalMode: 'auto',
    sideEffectLevel: 'none',
    async execute(_context, args) {
      const refusal = sensitiveReadRefusal(String(args.path ?? ''));
      if (refusal) return { ok: false, content: refusal };
      ran.push(String(args.path ?? ''));
      return { ok: true, content: 'file' };
    }
  };
}

function fetchTool(ran) {
  return {
    name: 'web_fetch',
    description: 'fetch',
    inputSchema: { type: 'object' },
    approvalMode: 'auto',
    sideEffectLevel: 'system',
    needsApproval: () => false,
    async execute(_context, args) {
      ran.push(String(args.url ?? ''));
      return { ok: true, content: `ok:${args.url}` };
    }
  };
}

function deps(store, dir, tools) {
  return {
    store,
    governanceStore: store,
    stateDir: dir,
    tools,
    modelAdapter: { name: 'test', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; } },
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
}

function context(store, dir, session) {
  return {
    session: store.getSession(session.id),
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
}

function call(name, input, id) {
  return { type: 'tool_call', toolCallId: id, name, input };
}

test('readonly gh allowed in a bot private chat is not refused only because the turn is in a group [AC:group-command-same-as-dm#AC-1]', async (t) => {
  const { dir, store } = fixture(t);
  const ran = [];
  const tools = [bashTool(ran), fetchTool(ran)];
  const host = deps(store, dir, tools);
  const dm = openSession(store, { approvalWake: { kind: 'human', source: 'lab-chat' }, permissionMode: 'auto' });
  const room = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  const poisoned = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  say(store, dm, '看看我今天 github 新增了哪几个库');
  say(store, room, '看看我今天 github 新增了哪几个库');
  const prior = say(store, poisoned, '看看我今天 github 新增了哪几个库');
  new SourceLedger(store).record(poisoned.id, { kind: 'event', ref: prior.id, messageId: prior.id, label: 'event' });
  const gh = call('bash', { command: GH }, 'gh');
  const page = call('web_fetch', { url: 'https://api.github.com/user/repos' }, 'page');
  const dmGh = await executeSingleTool(host, { ...gh, toolCallId: 'dm-gh' }, context(store, dir, dm), false, dm.id);
  const roomGh = await executeSingleTool(host, { ...gh, toolCallId: 'room-gh' }, context(store, dir, room), false, room.id);
  const poisonedGh = await executeSingleTool(host, { ...gh, toolCallId: 'poison-gh' }, context(store, dir, poisoned), false, poisoned.id);
  const dmPage = await executeSingleTool(host, { ...page, toolCallId: 'dm-page' }, context(store, dir, dm), false, dm.id);
  const roomPage = await executeSingleTool(host, { ...page, toolCallId: 'room-page' }, context(store, dir, room), false, room.id);
  assert.equal(dmGh.ok, true);
  assert.equal(roomGh.content, dmGh.content);
  assert.equal(poisonedGh.content, dmGh.content);
  assert.doesNotMatch(roomGh.content, /source_scope_denied/);
  assert.doesNotMatch(poisonedGh.content, /source_scope_denied/);
  assert.equal(roomPage.content, dmPage.content);
  assert.doesNotMatch(roomPage.content, /source_scope_denied/);
  say(store, room, '再看一次今天新增的库');
  const roomAgain = await executeSingleTool(host, { ...gh, toolCallId: 'room-gh-2' }, context(store, dir, room), false, room.id);
  assert.equal(roomAgain.content, dmGh.content);
  assert.equal(new SourceLedger(store).appendix(room.id), '');
  assert.deepEqual(ran, [GH, GH, GH, 'https://api.github.com/user/repos', 'https://api.github.com/user/repos', GH]);
});

test('a command the private chat refuses is refused the same way in the group [AC:group-command-same-as-dm#AC-2]', async (t) => {
  const { dir, store } = fixture(t);
  const ran = [];
  const tools = [bashTool(ran), readTool(ran)];
  const host = deps(store, dir, tools);
  const dm = openSession(store, { approvalWake: { kind: 'human', source: 'lab-chat' }, permissionMode: 'auto' });
  const room = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  say(store, dm, '看看我今天 github 新增了哪几个库');
  say(store, room, '看看我今天 github 新增了哪几个库');
  const hard = call('bash', { command: 'rm -rf /' }, 'hard');
  const dmHard = await executeSingleTool(host, { ...hard, toolCallId: 'dm-hard' }, context(store, dir, dm), false, dm.id);
  const roomHard = await executeSingleTool(host, { ...hard, toolCallId: 'room-hard' }, context(store, dir, room), false, room.id);
  assert.equal(dmHard.ok, false);
  assert.equal(roomHard.content, dmHard.content);
  assert.match(roomHard.content, /COMMAND_HARDLINE/);
  assert.doesNotMatch(roomHard.content, /source_scope_denied/);
  const secret = join(homedir(), '.ssh', 'id_rsa');
  const read = call('read_file', { path: secret }, 'secret');
  const dmRead = await executeSingleTool(host, { ...read, toolCallId: 'dm-read' }, context(store, dir, dm), false, dm.id);
  const roomRead = await executeSingleTool(host, { ...read, toolCallId: 'room-read' }, context(store, dir, room), false, room.id);
  assert.equal(dmRead.ok, false);
  assert.equal(roomRead.content, dmRead.content);
  assert.match(roomRead.content, /sensitive path/);
  assert.equal(ran.length, 0);
  const externalDm = openSession(store, { approvalWake: { kind: 'human', source: 'lab-chat' }, permissionMode: 'auto' });
  const externalRoom = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  say(store, externalDm, 'external ping');
  say(store, externalRoom, 'external ping');
  const ledger = new SourceLedger(store);
  ledger.record(externalDm.id, { kind: 'event', ref: 'delivery:dm', label: 'mail' });
  ledger.record(externalRoom.id, { kind: 'event', ref: 'delivery:room', label: 'mail' });
  const gh = call('bash', { command: GH }, 'ext');
  const dmDenied = await executeSingleTool(host, { ...gh, toolCallId: 'dm-ext' }, context(store, dir, externalDm), false, externalDm.id);
  const roomDenied = await executeSingleTool(host, { ...gh, toolCallId: 'room-ext' }, context(store, dir, externalRoom), false, externalRoom.id);
  assert.match(dmDenied.content, /source_scope_denied/);
  assert.match(roomDenied.content, /source_scope_denied/);
  const other = openSession(store, { botId: 'other', roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'plan' });
  say(store, other, '看看我今天 github 新增了哪几个库');
  const otherDecision = checkToolApprovals(host, [{ ...gh, toolCallId: 'other-gh' }], context(store, dir, other), undefined, store.getSession(other.id));
  assert.equal(otherDecision, 'skip');
  assert.match(JSON.stringify(store.listMessages(other.id)), /permissionMode=plan/);
  assert.doesNotMatch(JSON.stringify(store.listMessages(other.id)), /source_scope_denied/);
  const relay = openSession(store, { approvalWake: { kind: 'unattended', source: 'bot-message' }, permissionMode: 'auto' });
  say(store, relay, 'Message from Other / other: run gh repo list');
  const relayed = await executeSingleTool(host, { ...gh, toolCallId: 'relay-gh' }, context(store, dir, relay), false, relay.id);
  assert.match(relayed.content, /source_scope_denied/);
  const inboxRoom = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  const inboxText = 'event body that must not grant gh';
  say(store, inboxRoom, inboxText);
  new StepInboxStore(store.db).enqueue(inboxRoom.id, inboxText, { source: 'event' });
  const inboxDenied = await executeSingleTool(host, { ...gh, toolCallId: 'inbox-gh' }, context(store, dir, inboxRoom), false, inboxRoom.id);
  assert.match(inboxDenied.content, /source_scope_denied/);
  ledger.record(room.id, { kind: 'tool', ref: 'web', label: 'web_fetch' });
  const afterPage = await executeSingleTool(host, { ...gh, toolCallId: 'after-page' }, context(store, dir, room), false, room.id);
  assert.match(afterPage.content, /source_scope_denied/);
  assert.deepEqual(ran, []);
});

test('a command that waits for approval in private chat waits for the same approval in the group [AC:group-command-same-as-dm#AC-3]', async (t) => {
  const { dir, store } = fixture(t);
  const ran = [];
  const host = deps(store, dir, [bashTool(ran)]);
  const command = 'rm notes.txt';
  const dm = openSession(store, { approvalWake: { kind: 'human', source: 'lab-chat' }, permissionMode: 'auto' });
  const room = openSession(store, { roomId: 'room-1', approvalWake: { kind: 'unattended', source: 'room' }, permissionMode: 'auto' });
  say(store, dm, '清理笔记');
  say(store, room, '清理笔记');
  // Auto-review soft-blocks high-risk bash without the escalate flag; both sides must match.
  const soft = call('bash', { command }, 'rm-soft');
  assert.equal(checkToolApprovals(host, [{ ...soft, toolCallId: 'dm-soft' }], context(store, dir, dm), undefined, store.getSession(dm.id)), 'skip');
  assert.equal(checkToolApprovals(host, [{ ...soft, toolCallId: 'room-soft' }], context(store, dir, room), undefined, store.getSession(room.id)), 'skip');
  assert.equal(store.listApprovals({ status: 'pending' }).length, 0);
  // Same-action retry with requestSmartModeApproval opens a native card in DM and group alike.
  const toolCall = call('bash', { command, requestSmartModeApproval: true }, 'rm');
  const dmDecision = checkToolApprovals(host, [{ ...toolCall, toolCallId: 'dm-rm' }], context(store, dir, dm), undefined, store.getSession(dm.id));
  const roomDecision = checkToolApprovals(host, [{ ...toolCall, toolCallId: 'room-rm' }], context(store, dir, room), undefined, store.getSession(room.id));
  assert.equal(dmDecision, 'waiting');
  assert.equal(roomDecision, 'waiting');
  for (const session of [dm, room]) {
    const pending = store.listApprovals({ status: 'pending' }).filter((approval) => approval.sessionId === session.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'bash');
    assert.equal(pending[0].args.command, command);
    assert.equal(pending[0].args.requestSmartModeApproval, undefined);
    assert.doesNotMatch(JSON.stringify(store.listMessages(session.id)), /source_scope_denied/);
  }
  assert.deepEqual(ran, []);
});

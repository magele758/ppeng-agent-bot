import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SqliteStateStore } from '../dist/storage.js';
import { SourceLedger } from '../dist/learning/sources.js';
import { checkToolApprovals, executeSingleTool } from '../dist/runtime/tool-loop.js';
import { approve } from '../dist/runtime/session-facade.js';

const LS = 'ls -lt "$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"';
const COUNT = 'sqlite3 CloudRecordings.db "SELECT COUNT(*) FROM ZCLOUDRECORDING;"';

function fixture(t, metadata = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'local-scope-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createSession({
    agentId: 'general',
    title: 'bot',
    mode: 'chat',
    metadata: { userId: 'alice', botId: 'super', permissionMode: 'auto', approvalWake: { kind: 'human', source: 'lab-chat' }, ...metadata }
  });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: '读一下语音备忘录' }]);
  const ran = [];
  const bash = {
    name: 'bash',
    description: 'bash',
    inputSchema: { type: 'object' },
    approvalMode: 'auto',
    sideEffectLevel: 'workspace',
    needsApproval: () => false,
    async execute(_context, args) {
      ran.push(String(args.command));
      return { ok: true, content: `«external source=shell label=${args.command}»\nout\n«end external»` };
    }
  };
  const deps = {
    store,
    governanceStore: store,
    stateDir: dir,
    tools: [bash],
    modelAdapter: { name: 'test', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; } },
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
  const ctx = () => ({ session: store.getSession(session.id), repoRoot: dir, stateDir: dir, agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] } });
  const run = (input, id) => executeSingleTool(deps, { type: 'tool_call', toolCallId: id, name: 'bash', input }, ctx(), false, session.id);
  const gate = (input, id) => checkToolApprovals(deps, [{ type: 'tool_call', toolCallId: id, name: 'bash', input }], ctx(), undefined, store.getSession(session.id));
  return { store, session, ran, run, gate };
}

async function exposeWithLocalRead(f) {
  const first = await f.run({ command: LS }, 'ls');
  assert.equal(first.ok, true);
  await sleep(5);
}

test('an Auto-review card approved after exposure authorizes the same call carrying escalation flags [AC:local-source-unlock#AC-1]', async (t) => {
  const f = fixture(t);
  await exposeWithLocalRead(f);
  const flagged = { command: COUNT, isolation: 'direct', requestSmartModeApproval: true, smartModeBlockReason: 'Auto-review (shell) blocked' };
  const card = f.store.createApproval({ sessionId: f.session.id, toolName: 'bash', reason: 'Auto-review', args: { command: COUNT, isolation: 'direct' }, idempotencyKey: 'ar:x' });
  f.store.updateApproval(card.id, 'approved');
  const result = await f.run(flagged, 'count');
  assert.doesNotMatch(result.content, /source_scope_denied/);
  assert.deepEqual(f.ran, [LS, COUNT]);
});

test('a scope-refused call in an attended chat gets one approval card, runs once approved, stays refused when rejected [AC:local-source-unlock#AC-2]', async (t) => {
  const f = fixture(t);
  await exposeWithLocalRead(f);
  assert.equal(f.gate({ command: COUNT }, 'g1'), 'waiting');
  assert.equal(f.gate({ command: COUNT, requestSmartModeApproval: true }, 'g2'), 'waiting');
  const cards = f.store.listApprovals().filter((a) => a.sessionId === f.session.id);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].args, { command: COUNT });
  assert.match(cards[0].reason, /source scope/);
  assert.match((await f.run({ command: COUNT }, 'early')).content, /source_scope_denied/);
  await approve(f.store, cards[0].id, 'approved');
  assert.equal(f.gate({ command: COUNT }, 'g3'), 'proceed');
  assert.doesNotMatch((await f.run({ command: COUNT }, 'after')).content, /source_scope_denied/);
  assert.deepEqual(f.ran, [LS, COUNT]);

  await sleep(5);
  const other = 'sqlite3 CloudRecordings.db "SELECT ZPATH FROM ZCLOUDRECORDING LIMIT 5;"';
  assert.equal(f.gate({ command: other }, 'g4'), 'waiting');
  const second = f.store.listApprovals().find((a) => a.sessionId === f.session.id && a.args.command === other);
  await approve(f.store, second.id, 'rejected');
  assert.equal(f.gate({ command: other }, 'g5'), 'proceed');
  assert.match((await f.run({ command: other }, 'rej')).content, /source_scope_denied/);
});

test('routine and unattended sessions keep the immediate scope denial without a card [AC:local-source-unlock#AC-2]', async (t) => {
  const f = fixture(t, { approvalWake: { kind: 'unattended', source: 'routine' } });
  new SourceLedger(f.store).record(f.session.id, { kind: 'routine', ref: 'routine:1', label: 'routine' });
  assert.equal(f.gate({ command: COUNT }, 'g1'), 'proceed');
  assert.equal(f.store.listApprovals().length, 0);
  assert.match((await f.run({ command: COUNT }, 'r')).content, /source_scope_denied/);
  assert.deepEqual(f.ran, []);
});

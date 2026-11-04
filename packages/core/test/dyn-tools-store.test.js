import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDynToolStore,
  createDynToolStoreFromAgentMemory,
  createDynToolStoreFromSessionMemory,
  DYN_TOOL_PROMOTE_APPROVAL,
  DynToolError,
  MAX_ACTIVE_DRAFT_PER_SESSION,
  tryCreateDynToolStore
} from '../dist/dyn-tools/index.js';
import { approve } from '../dist/runtime/session-facade.js';
import { SqliteStateStore } from '../dist/storage.js';

function validInput(name, extra = {}) {
  return {
    name,
    description: 'd',
    source: { code: 'return args.x' },
    sessionId: extra.sessionId ?? 'sess-1',
    reservedNames: extra.reservedNames ?? ['bash'],
    status: extra.status ?? 'active',
    scope: extra.scope,
    inputSchema: extra.inputSchema
  };
}

function runStoreSuite(label, makeStore) {
  test(`${label}: upsert then get returns full fields`, () => {
    const store = makeStore();
    const rec = store.upsert(
      validInput('add_one', {
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } }
      })
    );
    const got = store.get('add_one', { sessionId: 'sess-1' });
    assert.equal(got.name, 'add_one');
    assert.equal(got.description, 'd');
    assert.equal(got.kind, 'ptc_cell');
    assert.equal(got.source.code, 'return args.x');
    assert.equal(got.status, 'active');
    assert.equal(got.scope, 'session.scratch');
    assert.equal(got.stats.uses, 0);
    assert.deepEqual(got.inputSchema, rec.inputSchema);
    assert.ok(got.createdAt);
    assert.ok(got.updatedAt);
  });

  test(`${label}: reserved builtin bash is rejected`, () => {
    const store = makeStore();
    assert.throws(
      () => store.upsert(validInput('bash')),
      (err) => err instanceof DynToolError && err.code === 'reserved_name'
    );
  });

  test(`${label}: 21st active/draft is rejected`, () => {
    const store = makeStore();
    for (let i = 0; i < MAX_ACTIVE_DRAFT_PER_SESSION; i += 1) {
      store.upsert(validInput(`tool_${i}`));
    }
    assert.throws(
      () => store.upsert(validInput('tool_overflow')),
      (err) => err instanceof DynToolError && err.code === 'quota'
    );
  });

  test(`${label}: retire excludes from listActive`, () => {
    const store = makeStore();
    store.upsert(validInput('keep_me'));
    store.upsert(validInput('drop_me'));
    store.retire('drop_me', 'sess-1');
    const active = store.listActive('sess-1').map((r) => r.name).sort();
    assert.deepEqual(active, ['keep_me']);
    assert.equal(store.get('drop_me', { sessionId: 'sess-1' }).status, 'retired');
  });
}

runStoreSuite('in-memory', () => createDynToolStore());

test('agent-memory backend: upsert/get/retire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-am-'));
  const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
  const store = createDynToolStoreFromAgentMemory(sqlite.agentMemory());
  store.upsert(validInput('mem_add'));
  assert.equal(store.get('mem_add', { sessionId: 'sess-1' }).name, 'mem_add');
  store.retire('mem_add', 'sess-1');
  assert.equal(store.listActive('sess-1').length, 0);
});

test('session-memory backend: upsert/get/retire', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-sm-'));
  const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
  const store = createDynToolStoreFromSessionMemory(sqlite);
  store.upsert(validInput('sess_add'));
  assert.equal(store.get('sess_add', { sessionId: 'sess-1' }).name, 'sess_add');
  store.retire('sess_add', 'sess-1');
  assert.equal(store.listActive('sess-1').length, 0);
});

test('approve promote uses tryCreateDynToolStore and emits dyn_tool_promote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-promote-'));
  const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
  const dyn = tryCreateDynToolStore(sqlite);
  assert.ok(dyn);
  dyn.upsert(validInput('add_one', { sessionId: 'sess-1' }));
  const approval = sqlite.createApproval({
    sessionId: 'sess-1',
    toolName: DYN_TOOL_PROMOTE_APPROVAL,
    reason: 'promote',
    args: { name: 'add_one', targetScope: 'project.memory' }
  });
  const traces = [];
  await approve(sqlite, approval.id, 'approved', {
    emitTrace: (sessionId, event) => traces.push({ sessionId, event })
  });
  assert.equal(dyn.get('add_one', { sessionId: 'sess-1' }).scope, 'project.memory');
  const promote = traces.find((item) => item.event.kind === 'dyn_tool_promote');
  assert.equal(promote?.event.payload.name, 'add_one');
});

test('session-memory backend ignores dirty rows without dyn-tools namespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-sm-dirty-'));
  const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
  const now = new Date().toISOString();
  sqlite.upsertSessionMemory({
    sessionId: 'sess-1',
    scope: 'scratch',
    key: 'add_one',
    value: JSON.stringify({
      name: 'add_one',
      description: 'dirty',
      inputSchema: {},
      kind: 'ptc_cell',
      source: { code: 'return 1' },
      scope: 'session.scratch',
      status: 'active',
      stats: { uses: 0 },
      createdAt: now,
      updatedAt: now
    }),
    source: 'user_provided',
    metadata: { note: 'not a dyn tool' }
  });
  const store = createDynToolStoreFromSessionMemory(sqlite);
  assert.equal(store.get('add_one', { sessionId: 'sess-1' }), undefined);
  assert.equal(store.list({ sessionId: 'sess-1' }).length, 0);
});

test('invalid name and empty code throw typed errors', () => {
  const store = createDynToolStore();
  assert.throws(() => store.upsert(validInput('BadName')), (err) => err.code === 'invalid_name');
  assert.throws(
    () => store.upsert({ ...validInput('ok_name'), source: { code: '   ' } }),
    (err) => err.code === 'empty_code'
  );
});

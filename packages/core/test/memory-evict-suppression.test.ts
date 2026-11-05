import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { AgentMemoryStore } from '../dist/memory/store.js';
import { gatedMemorySet } from '../dist/memory/memory-writer.js';
import { MemorySuppressedError } from '../dist/memory/deletion-suppression.js';

const fact = {
  scope: 'user.memory' as const,
  namespace: 'semantic',
  key: 'preference:style',
  value: '用户偏好简洁回答',
  userId: 'u1',
  tenantId: 't1',
  agentId: 'b1',
  importance: 0.8,
  confidence: 'high' as const
};

function open(t: import('node:test').TestContext, limits?: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-evict-'));
  const store = new SqliteStateStore(join(dir, 'db'));
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const am = limits ? new AgentMemoryStore(store.db, limits) : store.agentMemory();
  return { store, am };
}

test('capacity eviction suppresses the fact for a short time', (t) => {
  const { store, am } = open(t, { 'user.memory': 1 });
  am.set({ ...fact, key: 'keep', value: 'keep-me', importance: 0.9 });
  am.set({ ...fact, key: 'drop', value: 'evict-me', importance: 0.1 });
  const row = am.listSuppressions().find((item) => item.memory.value === 'evict-me');
  assert.equal(row?.reason, 'evicted');
  assert.ok(row?.expiresAt);
  const blocked = gatedMemorySet(am, {
    scope: 'user.memory',
    namespace: 'semantic',
    key: 'drop',
    value: 'evict-me',
    userId: 'u1',
    tenantId: 't1',
    agentId: 'b1'
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'evicted');
  store.db.prepare('UPDATE memory_suppressions SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), row!.id);
  assert.equal(am.findSuppression({ ...fact, value: 'evict-me' }), undefined);
  assert.equal(am.listSuppressions().some((item) => item.id === row!.id), false);
});

test('expire writes an expired suppression distinct from user deletion', (t) => {
  const { am } = open(t);
  am.set({ ...fact, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(am.expire(), 1);
  const row = am.listSuppressions()[0];
  assert.equal(row?.reason, 'expired');
  assert.throws(() => am.set(fact), (error: unknown) => error instanceof MemorySuppressedError && error.reason === 'expired');
});

test('user deletion stays permanent', (t) => {
  const { store, am } = open(t);
  const created = am.set(fact);
  am.deleteAndSuppress(created.id);
  const row = am.listSuppressions()[0]!;
  assert.equal(row.reason, 'user_deleted');
  assert.equal(row.expiresAt, undefined);
  store.db.prepare('UPDATE memory_suppressions SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), row.id);
  assert.equal(am.listSuppressions().length, 1);
  assert.throws(() => am.set(fact), (error: unknown) => error instanceof MemorySuppressedError && error.reason === 'user_deleted');
});

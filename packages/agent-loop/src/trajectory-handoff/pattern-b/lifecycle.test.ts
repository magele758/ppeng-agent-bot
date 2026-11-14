import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileLifecycleStore, createMemoryLifecycleStore } from './lifecycle.js';
import type { WorkspaceLifecycleRecord } from './types.js';

const host = { kind: 'host' as const };
const worker = { kind: 'worker' as const, workerId: 'w1' };
const now = '2026-11-14T00:00:00.000Z';
const later = '2026-11-14T01:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-b-lc-'));
  dirs.push(dir);
  return dir;
}

describe('workspace lifecycle records', () => {
  it('refuses worker create, retain, and cleanup', () => {
    const store = createMemoryLifecycleStore();
    const created = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'task',
      writableRoot: '/work/w1',
      now,
    });
    expect(created.ok).toBe(true);
    expect(store.create({
      actor: worker,
      runId: 'run',
      workerId: 'w2',
      taskScope: 'task',
      writableRoot: '/work/w2',
      now,
    })).toEqual({ ok: false, reason: 'worker_denied' });
    const id = created.ok ? created.record.lifecycleId : '';
    expect(store.retain({ actor: worker, lifecycleId: id, now: later })).toEqual({ ok: false, reason: 'worker_denied' });
    expect(store.cleanup({ actor: worker, lifecycleId: id, now: later })).toEqual({ ok: false, reason: 'worker_denied' });
    expect(store.get(id)?.phase).toBe('created');
  });

  it('creates a host record without handoff or budget fields and without mkdir', () => {
    const store = createMemoryLifecycleStore();
    const root = join(tempDir(), 'does-not-exist');
    const created = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'scope-a',
      writableRoot: root,
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Object.keys(created.record).sort()).toEqual([
      'createdAt',
      'discardConfirmed',
      'lifecycleId',
      'phase',
      'runId',
      'taskScope',
      'updatedAt',
      'workerId',
      'writableRoot',
    ]);
    expect(created.record.phase).toBe('created');
    expect(created.record.discardConfirmed).toBe(false);
    expect(existsSync(root)).toBe(false);
    const leaked = created.record as WorkspaceLifecycleRecord & Record<string, unknown>;
    expect(leaked.handoffState).toBeUndefined();
    expect(leaked.budget).toBeUndefined();
    expect(leaked.counters).toBeUndefined();
    expect(leaked.cap).toBeUndefined();
    expect(leaked.enabled).toBeUndefined();
  });

  it('replays the same worker root and rejects a moved root', () => {
    const store = createMemoryLifecycleStore();
    const first = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'scope-a',
      planId: 'plan',
      planVersion: '3',
      writableRoot: '/work/w1',
      now,
    });
    const replay = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'other-scope',
      writableRoot: '/work/w1/',
      now: later,
    });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.record).toEqual(first.record);
    expect(replay.record.taskScope).toBe('scope-a');
    expect(store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'scope-a',
      writableRoot: '/work/elsewhere',
      now: later,
    })).toEqual({ ok: false, reason: 'root_conflict' });
    expect(store.get(first.record.lifecycleId)?.writableRoot).toBe('/work/w1');
  });

  it('rejects overlapping roots and allows prefix siblings', () => {
    const store = createMemoryLifecycleStore();
    expect(store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'a',
      writableRoot: '/tmp/w1',
      now,
    }).ok).toBe(true);
    expect(store.create({
      actor: host,
      runId: 'run',
      workerId: 'w2',
      taskScope: 'b',
      writableRoot: '/tmp/w1/nested',
      now,
    })).toEqual({ ok: false, reason: 'root_conflict' });
    expect(store.create({
      actor: host,
      runId: 'run',
      workerId: 'w3',
      taskScope: 'c',
      writableRoot: '/tmp/w1-evil',
      now,
    }).ok).toBe(true);
  });

  it('retains unintegrated work and refuses cleanup until discard is confirmed', () => {
    const store = createMemoryLifecycleStore();
    const created = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'a',
      writableRoot: '/work/w1',
      now,
    });
    if (!created.ok) throw new Error('create failed');
    const retained = store.retain({ actor: host, lifecycleId: created.record.lifecycleId, now: later });
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.record.phase).toBe('retained');
    expect(retained.record.discardConfirmed).toBe(false);
    expect(store.cleanup({ actor: host, lifecycleId: created.record.lifecycleId, now: later })).toEqual({
      ok: false,
      reason: 'not_discardable',
    });
    expect(store.get(created.record.lifecycleId)?.phase).toBe('retained');
    expect(store.confirmDiscard({ actor: host, lifecycleId: created.record.lifecycleId, now: later }).ok).toBe(true);
    const cleaned = store.cleanup({ actor: host, lifecycleId: created.record.lifecycleId, now: later });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) return;
    expect(cleaned.record.phase).toBe('cleaned');
    expect(store.get(created.record.lifecycleId)?.phase).toBe('cleaned');
    expect(store.cleanup({ actor: host, lifecycleId: created.record.lifecycleId, now: later }).ok).toBe(true);
  });

  it('reloads retained records and fails closed on a corrupt file', () => {
    const dir = tempDir();
    const file = join(dir, 'lifecycle.json');
    const root = join(dir, 'missing-workspace');
    const store = createFileLifecycleStore(file);
    const created = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'a',
      writableRoot: root,
      now,
    });
    if (!created.ok) throw new Error('create failed');
    store.retain({ actor: host, lifecycleId: created.record.lifecycleId, now: later });
    const reloaded = createFileLifecycleStore(file);
    expect(reloaded.get(created.record.lifecycleId)).toMatchObject({
      phase: 'retained',
      discardConfirmed: false,
      taskScope: 'a',
    });
    expect(existsSync(root)).toBe(false);
    writeFileSync(file, '{');
    expect(() => createFileLifecycleStore(file)).toThrow('lifecycle store unreadable');
  });

  it('does not let a caller mutate the stored record', () => {
    const store = createMemoryLifecycleStore();
    const created = store.create({
      actor: host,
      runId: 'run',
      workerId: 'w1',
      taskScope: 'a',
      writableRoot: '/work/w1',
      now,
    });
    if (!created.ok) throw new Error('create failed');
    created.record.phase = 'cleaned';
    expect(store.get(created.record.lifecycleId)?.phase).toBe('created');
  });
});

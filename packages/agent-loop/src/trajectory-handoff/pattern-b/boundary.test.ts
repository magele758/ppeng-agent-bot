import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitWorkerWrite, boundaryFromLifecycle } from './boundary.js';
import { canonicalPath } from './paths.js';
import { WRITE_CHANNELS, type BoundaryDecision, type BoundaryRegistry, type WorkerIdentity, type WriteAdmission } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostCanonical(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return canonicalPath(path);
  }
}

function actor(workerId: string, extra: Partial<WorkerIdentity> = {}): WorkerIdentity {
  return { runId: 'run', workerId, taskScope: 'scope', ...extra };
}

function registry(overrides: Partial<BoundaryRegistry> = {}): BoundaryRegistry {
  return {
    hostEnforced: true,
    canonicalize: hostCanonical,
    boundaries: [
      {
        identity: actor('w1', { planId: 'plan', planVersion: '3' }),
        writableRoot: '/work/w1',
        role: 'executor',
        effectiveWrite: true,
      },
      {
        identity: actor('w2'),
        writableRoot: '/work/w2',
        role: 'executor',
        effectiveWrite: true,
      },
    ],
    sharedTargets: [{ targetId: 'shared', path: '/work/shared', expectedVersion: 'v1' }],
    readOnlyMounts: [
      { path: '/work/w1/cache', kind: 'cache' },
      { path: '/inputs', kind: 'input' },
    ],
    ...overrides,
  };
}

function write(partial: Partial<WriteAdmission> = {}): WriteAdmission {
  return {
    actor: actor('w1', { planId: 'plan', planVersion: '3' }),
    role: 'executor',
    channel: 'tool',
    path: '/work/w1/src/file.ts',
    ...partial,
  };
}

function denied(decision: BoundaryDecision): string {
  return decision.allowed ? 'allowed' : decision.code;
}

describe('writable boundary guard', () => {
  it('allows an executor write inside the enforced root', () => {
    expect(admitWorkerWrite(registry(), write())).toEqual({ allowed: true });
  });

  it('denies another worker, the shared target, prefix siblings, and lexical escapes', () => {
    expect(denied(admitWorkerWrite(registry(), write({ path: '/work/w2/file.ts' })))).toBe('other_worker');
    expect(denied(admitWorkerWrite(registry(), write({ path: '/work/w1/../shared/app.js' })))).toBe('shared_target');
    expect(denied(admitWorkerWrite(registry(), write({ path: '/work/w1-evil/file.ts' })))).toBe('outside_writable');
    expect(denied(admitWorkerWrite(registry(), write({
      path: '/work/shared/app.js',
      workerClaimsSharedWrite: true,
    })))).toBe('shared_target');
  });

  it('denies read-only mounts even when they sit inside the writable root', () => {
    expect(denied(admitWorkerWrite(registry(), write({ path: '/work/w1/cache/pkg' })))).toBe('read_only_mount');
    expect(denied(admitWorkerWrite(registry(), write({ path: '/inputs/snapshot' })))).toBe('read_only_mount');
  });

  it('fails closed without host enforcement or a canonicalizer', () => {
    expect(denied(admitWorkerWrite(registry({ hostEnforced: false }), write({ workerClaimsIsolation: true })))).toBe('not_enforced');
    expect(denied(admitWorkerWrite(registry({ canonicalize: undefined }), write()))).toBe('not_enforced');
  });

  it('denies planner writes and host operations', () => {
    expect(denied(admitWorkerWrite(registry(), write({ role: 'planner' })))).toBe('planner_write');
    expect(denied(admitWorkerWrite(registry(), write({ role: 'planner', hostOperation: 'cleanup' })))).toBe('host_operation');
    expect(denied(admitWorkerWrite(registry(), write({ hostOperation: 'integrate' })))).toBe('host_operation');
    expect(denied(admitWorkerWrite(registry(), write({ hostOperation: 'create' })))).toBe('host_operation');
  });

  it('refuses shared-scope edits and self-reported gate skips', () => {
    expect(denied(admitWorkerWrite(registry(), write({ sharedScopeChange: true })))).toBe('shared_scope_escalated');
    expect(denied(admitWorkerWrite(registry(), write({ workerClaimsSkipGate: true })))).toBe('self_reported');
  });

  it('denies every equivalent write channel and unknown channels', () => {
    for (const channel of WRITE_CHANNELS) {
      expect(denied(admitWorkerWrite(registry(), write({ channel, path: '/work/w2/file.ts' })))).toBe('other_worker');
    }
    expect(denied(admitWorkerWrite(registry(), write({ channel: 'socket' })))).toBe('unscoped_channel');
  });

  it('denies writes outside the permission intersection or a mismatched plan', () => {
    const boundaries = registry().boundaries.map((boundary) =>
      boundary.identity.workerId === 'w1' ? { ...boundary, effectiveWrite: false } : boundary
    );
    expect(denied(admitWorkerWrite(registry({ boundaries }), write()))).toBe('permission_denied');
    expect(denied(admitWorkerWrite(registry(), write({
      actor: actor('w1', { planId: 'plan', planVersion: '2' }),
    })))).toBe('outside_writable');
  });

  it('denies a symlink inside the root whose real path is outside', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pattern-b-boundary-'));
    dirs.push(dir);
    const root = join(dir, 'w1');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(root, 'link'));
    const decision = admitWorkerWrite(registry({
      boundaries: [{
        identity: actor('w1'),
        writableRoot: root,
        role: 'executor',
        effectiveWrite: true,
      }],
      sharedTargets: [],
      readOnlyMounts: [],
    }), write({
      actor: actor('w1'),
      path: join(root, 'link', 'secret'),
    }));
    expect(decision).toEqual({
      allowed: false,
      code: 'outside_writable',
      reason: 'Write path is outside the worker writable root',
    });
  });

  it('maps a lifecycle record onto a boundary without granting extra authority', () => {
    const boundary = boundaryFromLifecycle({
      lifecycleId: 'lc:run:w1',
      runId: 'run',
      workerId: 'w1',
      taskScope: 'scope',
      writableRoot: '/work/w1',
      phase: 'created',
      discardConfirmed: false,
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    }, 'executor', true);
    expect(boundary).toEqual({
      identity: { runId: 'run', workerId: 'w1', taskScope: 'scope' },
      writableRoot: '/work/w1',
      role: 'executor',
      effectiveWrite: true,
    });
    expect('budget' in boundary).toBe(false);
  });
});

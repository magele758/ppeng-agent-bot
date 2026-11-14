import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileIntegrationStore,
  createMemoryIntegrationStore,
  logicalIntegrationKey,
  type AuthorizeInput,
  type BindingProof,
  type IntegrationEffects,
} from './integration-store.js';
import { admitProductionWrite, patternBProductionEntryOpen } from './production-entry.js';
import type { IntegrationRecord } from './types.js';

const host = { kind: 'host' as const };
const now = '2026-11-14T00:00:00.000Z';
const soon = '2026-11-14T01:00:00.000Z';
const deadline = '2026-11-14T02:00:00.000Z';
const late = '2026-11-14T03:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pattern-b-int-'));
  dirs.push(dir);
  return dir;
}

function auth(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    actor: host,
    integrationId: 'int-1',
    runId: 'run',
    workerId: 'w1',
    planVersion: '3',
    taskScope: 'scope',
    artifactVersion: 'art-1',
    targetId: 'shared',
    expectedTargetVersion: 'v1',
    resultTargetVersion: 'v2',
    deadlineAt: deadline,
    now,
    ...overrides,
  };
}

function proofOf(input: AuthorizeInput): BindingProof {
  return {
    runId: input.runId,
    workerId: input.workerId,
    planVersion: input.planVersion,
    taskScope: input.taskScope,
    artifactVersion: input.artifactVersion,
    expectedTargetVersion: input.expectedTargetVersion,
  };
}

function harness(options?: {
  targets?: Record<string, string>;
  apply?: (record: IntegrationRecord) => void;
}) {
  const calls: string[] = [];
  const effects: IntegrationEffects = {
    apply(record) {
      calls.push(record.integrationId);
      options?.apply?.(record);
    },
  };
  return {
    calls,
    store: createMemoryIntegrationStore(effects, { targets: options?.targets ?? { shared: 'v1' } }),
  };
}

describe('local integration store', () => {
  it('rejects worker authorization and invalid input without applying', () => {
    const { calls, store } = harness();
    expect(store.authorize(auth({ actor: { kind: 'worker', workerId: 'w1' } }))).toEqual({
      ok: false,
      reason: 'worker_denied',
    });
    expect(store.authorize(auth({ integrationId: '' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(store.authorize(auth({ now: 'not-a-time' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(calls).toEqual([]);
    expect(store.get('int-1')).toBeUndefined();
  });

  it('records the expected target baseline and does not apply on authorize', () => {
    const { calls, store } = harness();
    const created = store.authorize(auth());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.record.status).toBe('authorized');
    expect(created.record.expectedTargetVersion).toBe('v1');
    expect(created.record.sideEffectCount).toBe(0);
    expect(created.record.logicalKey).toBe(logicalIntegrationKey(created.record));
    expect(store.targetVersion('shared')).toBe('v1');
    expect(calls).toEqual([]);
    const leaked = created.record as IntegrationRecord & Record<string, unknown>;
    expect(leaked.budget).toBeUndefined();
    expect(leaked.handoffState).toBeUndefined();
    expect(leaked.cap).toBeUndefined();
    expect(leaked.enabled).toBeUndefined();
  });

  it('is idempotent for the same integrationId and keeps a conflicting payload off the record', () => {
    const { calls, store } = harness();
    const first = store.authorize(auth());
    const replay = store.authorize(auth({ now: soon }));
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.record).toEqual(first.record);
    expect(replay.record.authorizedAt).toBe(now);
    const conflict = store.authorize(auth({ expectedTargetVersion: 'v9', deadlineAt: late }));
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toBe('binding_mismatch');
    expect(conflict.record?.expectedTargetVersion).toBe('v1');
    expect(conflict.record?.deadlineAt).toBe(deadline);
    expect(store.get('int-1')?.status).toBe('authorized');
    expect(calls).toEqual([]);
  });

  it('refuses a new integrationId while the same logical integration is pending', () => {
    const { calls, store } = harness();
    expect(store.authorize(auth()).ok).toBe(true);
    const pending = store.authorize(auth({
      integrationId: 'int-2',
      expectedTargetVersion: 'v9',
      resultTargetVersion: 'v10',
    }));
    expect(pending.ok).toBe(false);
    if (pending.ok) return;
    expect(pending.reason).toBe('in_flight');
    expect(pending.record?.integrationId).toBe('int-1');
    expect(store.get('int-2')).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('accepts one conditional submit and rejects the other without a second apply', () => {
    const { calls, store } = harness();
    const first = auth();
    const second = auth({ integrationId: 'int-2', workerId: 'w2', artifactVersion: 'art-2' });
    expect(store.authorize(first).ok).toBe(true);
    expect(store.authorize(second).ok).toBe(true);
    const begun = store.begin('int-1', proofOf(first), soon);
    expect(begun.ok).toBe(true);
    const held = store.begin('int-2', proofOf(second), soon);
    expect(held.ok).toBe(false);
    if (held.ok) return;
    expect(held.reason).toBe('target_held');
    expect(held.record?.status).toBe('rejected');
    const committed = store.commit('int-1', soon);
    expect(committed.ok).toBe(true);
    expect(store.targetVersion('shared')).toBe('v2');
    expect(store.commit('int-1', soon).ok).toBe(true);
    expect(store.targetVersion('shared')).toBe('v2');
    expect(store.get('int-2')?.status).toBe('rejected');
    const retry = store.authorize(auth({ integrationId: 'int-3', workerId: 'w2', artifactVersion: 'art-2' }));
    expect(retry.ok).toBe(true);
    const moved = store.begin('int-3', proofOf(second), soon);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.reason).toBe('target_moved');
    expect(calls).toEqual(['int-1']);
  });

  it('does not apply the same integrationId twice', () => {
    const { calls, store } = harness();
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(store.get('int-1')).toMatchObject({ status: 'applying', sideEffectCount: 1 });
    expect(calls).toEqual(['int-1']);
  });

  it('marks a failed apply unknown and does not replay it', () => {
    const { calls, store } = harness({
      apply() {
        throw new Error('disk');
      },
    });
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    const failed = store.begin('int-1', proofOf(input), soon);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('fail_closed');
    expect(failed.record?.status).toBe('unknown');
    expect(store.begin('int-1', proofOf(input), soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(store.commit('int-1', soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(store.targetVersion('shared')).toBe('v1');
    const blocked = store.authorize(auth({ integrationId: 'int-2' }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toBe('in_flight');
    expect(store.reconcile('int-1', { observed: 'unavailable' }, soon)).toMatchObject({
      ok: false,
      reason: 'fail_closed',
    });
    expect(store.get('int-1')?.status).toBe('unknown');
    expect(calls).toEqual(['int-1']);
  });

  it('reconciles an unknown result from evidence and does not apply again', () => {
    const { calls, store } = harness();
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(store.crashUncommitted('int-1')?.status).toBe('unknown');
    expect(store.begin('int-1', proofOf(input), soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(store.reconcile('int-1', { observed: 'applied', observedTargetVersion: 'stale' }, soon)).toMatchObject({
      ok: false,
      reason: 'fail_closed',
    });
    expect(store.get('int-1')?.status).toBe('unknown');
    const accepted = store.reconcile('int-1', { observed: 'applied', observedTargetVersion: 'v2' }, late);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.record.status).toBe('accepted');
    expect(store.targetVersion('shared')).toBe('v2');
    expect(store.reconcile('int-1', { observed: 'applied', observedTargetVersion: 'v2' }, late).ok).toBe(true);
    expect(calls).toEqual(['int-1']);
    expect(store.authorize(auth({ integrationId: 'int-2' }))).toMatchObject({
      ok: false,
      reason: 'already_accepted',
    });
  });

  it('allows a new integrationId only after unknown work is reconciled as not applied', () => {
    let fail = true;
    const { calls, store } = harness({
      apply() {
        if (fail) throw new Error('disk');
      },
    });
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(false);
    expect(store.authorize(auth({ integrationId: 'int-2' })).ok).toBe(false);
    const closed = store.reconcile('int-1', { observed: 'not_applied' }, soon);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.record.status).toBe('rejected');
    fail = false;
    const again = auth({ integrationId: 'int-3' });
    expect(store.authorize(again).ok).toBe(true);
    expect(store.begin('int-3', proofOf(again), soon).ok).toBe(true);
    expect(calls).toEqual(['int-1', 'int-3']);
  });

  it('does not commit after the deadline or after the baseline moves', () => {
    const { calls, store } = harness();
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(true);
    const expired = store.commit('int-1', late);
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.reason).toBe('expired');
    expect(expired.record?.status).toBe('unknown');
    expect(store.targetVersion('shared')).toBe('v1');
    expect(store.commit('int-1', soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(calls).toEqual(['int-1']);

    const other = harness();
    const second = auth();
    expect(other.store.authorize(second).ok).toBe(true);
    expect(other.store.begin('int-1', proofOf(second), soon).ok).toBe(true);
    other.store.noteTargetVersion('shared', 'v9', soon);
    expect(other.store.get('int-1')?.status).toBe('applying');
    expect(other.store.commit('int-1', soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(other.store.targetVersion('shared')).toBe('v9');
    expect(other.store.reconcile('int-1', { observed: 'applied', observedTargetVersion: 'v2' }, soon)).toMatchObject({
      ok: false,
      reason: 'fail_closed',
    });
    expect(other.store.get('int-1')?.status).toBe('unknown');
    expect(other.calls).toEqual(['int-1']);
  });

  it('ignores late, mismatched, and invalidated authorizations', () => {
    const { calls, store } = harness();
    const stale = store.authorize(auth({ integrationId: 'late', deadlineAt: now }));
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.record.status).toBe('expired');
    expect(store.begin('late', proofOf(auth({ integrationId: 'late', deadlineAt: now })), soon)).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    const input = auth();
    expect(store.authorize(input).ok).toBe(true);
    expect(store.begin('int-1', { ...proofOf(input), artifactVersion: 'other' }, soon)).toMatchObject({
      ok: false,
      reason: 'binding_mismatch',
    });
    expect(store.get('int-1')?.status).toBe('rejected');
    const fresh = auth({ integrationId: 'int-4', artifactVersion: 'art-4' });
    expect(store.authorize(fresh).ok).toBe(true);
    expect(store.invalidate({}, soon)).toEqual([]);
    const invalidated = store.invalidate({ taskScope: 'scope' }, soon);
    expect(invalidated.map((record) => record.integrationId)).toEqual(['int-4']);
    expect(store.begin('int-4', proofOf(fresh), soon).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reloads a crashed apply as unknown and fails closed on a corrupt file', () => {
    const dir = tempDir();
    const file = join(dir, 'integrations.json');
    const key = logicalIntegrationKey({
      runId: 'run',
      workerId: 'w1',
      planVersion: '3',
      taskScope: 'scope',
      artifactVersion: 'art-1',
      targetId: 'shared',
    });
    writeFileSync(file, JSON.stringify({
      records: [{
        integrationId: 'int-1',
        runId: 'run',
        workerId: 'w1',
        planVersion: '3',
        taskScope: 'scope',
        artifactVersion: 'art-1',
        targetId: 'shared',
        expectedTargetVersion: 'v1',
        resultTargetVersion: 'v2',
        deadlineAt: deadline,
        authorizedAt: now,
        status: 'applying',
        sideEffectCount: 1,
        logicalKey: key,
      }],
      targets: { shared: { version: 'v1', holder: 'int-1' } },
    }));
    const calls: string[] = [];
    const store = createFileIntegrationStore(file, {
      apply(record) {
        calls.push(record.integrationId);
      },
    });
    expect(store.get('int-1')?.status).toBe('unknown');
    expect(store.begin('int-1', proofOf(auth()), soon)).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(store.authorize(auth({ integrationId: 'int-2' })).ok).toBe(false);
    expect(calls).toEqual([]);

    const acceptedFile = join(dir, 'accepted.json');
    const durable = createFileIntegrationStore(acceptedFile, { apply() {} }, { targets: { shared: 'v1' } });
    const input = auth();
    expect(durable.authorize(input).ok).toBe(true);
    expect(durable.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(durable.commit('int-1', soon).ok).toBe(true);
    const reloaded = createFileIntegrationStore(acceptedFile, {
      apply() {
        calls.push('reloaded');
      },
    });
    expect(reloaded.targetVersion('shared')).toBe('v2');
    expect(reloaded.get('int-1')?.status).toBe('accepted');
    expect(reloaded.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(calls).toEqual([]);

    writeFileSync(acceptedFile, '{');
    expect(() => createFileIntegrationStore(acceptedFile, { apply() {} })).toThrow('integration store unreadable');
    const smuggled = join(dir, 'budget.json');
    writeFileSync(smuggled, JSON.stringify({
      records: [{
        integrationId: 'int-1',
        runId: 'run',
        workerId: 'w1',
        planVersion: '3',
        taskScope: 'scope',
        artifactVersion: 'art-1',
        targetId: 'shared',
        expectedTargetVersion: 'v1',
        resultTargetVersion: 'v2',
        deadlineAt: deadline,
        authorizedAt: now,
        status: 'authorized',
        sideEffectCount: 0,
        logicalKey: key,
        budget: 9,
      }],
      targets: { shared: { version: 'v1' } },
    }));
    expect(() => createFileIntegrationStore(smuggled, { apply() {} })).toThrow('integration store unreadable');
  });

  it('does not let a caller mutate the stored record or open the production entry', () => {
    const { store } = harness();
    const created = store.authorize(auth());
    if (!created.ok) throw new Error('authorize failed');
    created.record.status = 'accepted';
    expect(store.get('int-1')?.status).toBe('authorized');
    const input = auth();
    expect(store.begin('int-1', proofOf(input), soon).ok).toBe(true);
    expect(store.commit('int-1', soon).ok).toBe(true);
    expect(patternBProductionEntryOpen()).toBe(false);
    expect(admitProductionWrite()).toEqual({
      allowed: false,
      code: 'entry_closed',
      reason: 'Pattern B production entry is closed',
    });
  });
});

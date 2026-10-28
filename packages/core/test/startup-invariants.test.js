/**
 * Startup invariants: compact policy, stable prefix hash, repeatGuard.
 * Persisted Lab settings win; invalid blobs are repaired and logged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  COMPACT_SETTINGS_KEY,
  assertCompactInvariant,
  assertRepeatGuardInvariant,
  assertStablePrefixInvariant,
  assertStartupInvariants,
  hashStablePrefix,
  stablePrefixHashOf,
  stablePrefixIdentitySegment,
  StartupInvariantError
} from '../src/session/startup-invariants.ts';

/**
 * Same bounds as parseKeepRecent / defaultCompactSettings: known policy,
 * integer keepRecent 0..50, otherwise keep_recent / 3. The startup helper
 * receives this from compact-settings; the test passes it in directly so it
 * does not load @ppeng/agent-loop.
 */
function normalize(raw) {
  const base = { policy: 'keep_recent', keepRecent: 3, updatedAt: 'default' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const policies = ['keep_recent', 'after_any_assistant', 'after_text_assistant'];
  const policy = policies.includes(raw.policy) ? raw.policy : base.policy;
  const keep = raw.keepRecent;
  const keepRecent =
    typeof keep === 'number' && Number.isInteger(keep) && keep >= 0 && keep <= 50
      ? keep
      : base.keepRecent;
  return {
    policy,
    keepRecent,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

const LOOP_SETTINGS_KEY = 'loop_settings';

function memStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getDaemonControl(key) {
      return data.get(key);
    },
    setDaemonControl(key, value) {
      data.set(key, value);
    }
  };
}

function captureLog() {
  const lines = [];
  return {
    lines,
    warn(...args) {
      lines.push(['warn', ...args]);
    },
    info(...args) {
      lines.push(['info', ...args]);
    }
  };
}

test('saved compact policy wins over the built-in default [AC:startup-invariants-compact#AC-1]', () => {
  const store = memStore({
    [COMPACT_SETTINGS_KEY]: {
      policy: 'after_text_assistant',
      keepRecent: 7,
      updatedAt: '2026-10-01T00:00:00.000Z'
    }
  });
  const log = captureLog();
  const compact = assertCompactInvariant(store, normalize, log);
  assert.equal(compact.policy, 'after_text_assistant');
  assert.equal(compact.keepRecent, 7);
  assert.equal(compact.source, 'ui');
  assert.equal(compact.repaired, false);
  assert.equal(log.lines.some((line) => line[0] === 'warn'), false);
  assert.equal(store.getDaemonControl(COMPACT_SETTINGS_KEY).policy, 'after_text_assistant');
});

test('each allowed compact policy and an in-range keepRecent are accepted [AC:startup-invariants-compact#AC-1]', () => {
  for (const policy of ['keep_recent', 'after_any_assistant', 'after_text_assistant']) {
    const store = memStore({
      [COMPACT_SETTINGS_KEY]: { policy, keepRecent: 0, updatedAt: 't' }
    });
    const compact = assertCompactInvariant(store, normalize);
    assert.equal(compact.policy, policy);
    assert.equal(compact.keepRecent, 0);
    assert.equal(compact.repaired, false);
  }
  const upper = memStore({
    [COMPACT_SETTINGS_KEY]: { policy: 'keep_recent', keepRecent: 50, updatedAt: 't' }
  });
  assert.equal(assertCompactInvariant(upper, normalize).keepRecent, 50);
});

test('missing compact settings use the built-in default [AC:startup-invariants-compact#AC-2]', () => {
  const store = memStore();
  const compact = assertCompactInvariant(store, normalize, captureLog());
  assert.equal(compact.policy, 'keep_recent');
  assert.equal(typeof compact.keepRecent, 'number');
  assert.ok(compact.keepRecent >= 0 && compact.keepRecent <= 50);
  assert.equal(compact.source, 'default');
  assert.equal(compact.repaired, false);
  assert.equal(store.getDaemonControl(COMPACT_SETTINGS_KEY), undefined);
});

test('invalid compact settings are repaired and logged [AC:startup-invariants-compact#AC-2]', () => {
  const store = memStore({
    [COMPACT_SETTINGS_KEY]: { policy: 'delete_everything', keepRecent: 999, updatedAt: 't' }
  });
  const log = captureLog();
  const compact = assertCompactInvariant(store, normalize, log);
  assert.equal(compact.policy, 'keep_recent');
  assert.ok(compact.keepRecent >= 0 && compact.keepRecent <= 50);
  assert.equal(compact.repaired, true);
  assert.equal(compact.source, 'ui');
  const saved = store.getDaemonControl(COMPACT_SETTINGS_KEY);
  assert.equal(saved.policy, 'keep_recent');
  assert.equal(saved.keepRecent, compact.keepRecent);
  assert.ok(log.lines.some((line) => line[0] === 'warn' && String(line[1]).includes('compact')));
});

test('a non-object compact blob is repaired instead of left undefined [AC:startup-invariants-compact#AC-2]', () => {
  const store = memStore({ [COMPACT_SETTINGS_KEY]: 'nope' });
  const log = captureLog();
  const compact = assertCompactInvariant(store, normalize, log);
  assert.equal(compact.policy, 'keep_recent');
  assert.equal(compact.repaired, true);
  assert.equal(store.getDaemonControl(COMPACT_SETTINGS_KEY).policy, 'keep_recent');
  assert.ok(log.lines.some((line) => line[0] === 'warn'));
});

test('stable prefix segment is non-empty and its hash is stable [AC:startup-invariants-compact#AC-3]', () => {
  const identity = { agentName: 'General', agentRole: 'assistant', repoRoot: '/work/repo' };
  const first = assertStablePrefixInvariant(identity);
  const second = assertStablePrefixInvariant(identity);
  assert.match(first.segment, /General/);
  assert.match(first.segment, /assistant/);
  assert.match(first.segment, /\/work\/repo/);
  assert.ok(first.segment.trim().length > 0);
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash.length, 16);
  assert.equal(first.hash, stablePrefixHashOf(first.segment));
  assert.equal(hashStablePrefix(first.segment), first.hash);
  const expected = createHash('sha256').update(first.segment).digest('hex').slice(0, 16);
  assert.equal(first.hash, expected);
  assert.equal(stablePrefixIdentitySegment(identity), first.segment);
});

test('a different identity changes the stable prefix hash [AC:startup-invariants-compact#AC-3]', () => {
  const a = assertStablePrefixInvariant({ agentName: 'A', agentRole: 'assistant', repoRoot: '/one' });
  const b = assertStablePrefixInvariant({ agentName: 'B', agentRole: 'assistant', repoRoot: '/one' });
  assert.notEqual(a.hash, b.hash);
});

test('blank agent identity fails closed [AC:startup-invariants-compact#AC-4]', () => {
  const cases = [
    { agentName: '  ', agentRole: 'assistant', repoRoot: '/work' },
    { agentName: 'General', agentRole: '', repoRoot: '/work' },
    { agentName: 'General', agentRole: 'assistant', repoRoot: '   ' }
  ];
  for (const identity of cases) {
    assert.throws(() => assertStablePrefixInvariant(identity), StartupInvariantError);
  }
  assert.throws(() => hashStablePrefix('   '), StartupInvariantError);
});

test('saved repeatGuard modes pass through and missing stays weak [AC:startup-invariants-compact#AC-5]', () => {
  for (const mode of ['weak', 'all', 'off']) {
    const store = memStore({ [LOOP_SETTINGS_KEY]: { repeatGuard: mode, kernelVariant: 'agent-loop' } });
    const guard = assertRepeatGuardInvariant(store, captureLog());
    assert.equal(guard.mode, mode);
    assert.equal(guard.repaired, false);
    assert.equal(store.getDaemonControl(LOOP_SETTINGS_KEY).repeatGuard, mode);
  }
  const missing = memStore();
  const fallback = assertRepeatGuardInvariant(missing, captureLog());
  assert.equal(fallback.mode, 'weak');
  assert.equal(fallback.repaired, false);
  assert.equal(missing.getDaemonControl(LOOP_SETTINGS_KEY), undefined);
});

test('invalid repeatGuard falls back to weak and is logged [AC:startup-invariants-compact#AC-6]', () => {
  const store = memStore({
    [LOOP_SETTINGS_KEY]: { repeatGuard: 'sometimes', kernelVariant: 'agent-loop' }
  });
  const log = captureLog();
  const guard = assertRepeatGuardInvariant(store, log);
  assert.equal(guard.mode, 'weak');
  assert.equal(guard.repaired, true);
  assert.equal(store.getDaemonControl(LOOP_SETTINGS_KEY).repeatGuard, 'weak');
  assert.equal(store.getDaemonControl(LOOP_SETTINGS_KEY).kernelVariant, 'agent-loop');
  assert.ok(log.lines.some((line) => line[0] === 'warn' && String(line[1]).includes('repeatGuard')));
});

test('startup check reports all three invariants together [AC:startup-invariants-compact#AC-1] [AC:startup-invariants-compact#AC-5]', () => {
  const store = memStore({
    [COMPACT_SETTINGS_KEY]: { policy: 'after_any_assistant', keepRecent: 2, updatedAt: 't' },
    [LOOP_SETTINGS_KEY]: { repeatGuard: 'off' }
  });
  const log = captureLog();
  const result = assertStartupInvariants({
    store,
    normalizeCompact: normalize,
    identity: { agentName: 'General', agentRole: 'assistant', repoRoot: '/work/repo' },
    log
  });
  assert.equal(result.compact.policy, 'after_any_assistant');
  assert.equal(result.compact.keepRecent, 2);
  assert.equal(result.repeatGuard.mode, 'off');
  assert.equal(result.stablePrefix.hash.length, 16);
  assert.ok(log.lines.some((line) => line[0] === 'info'));
});

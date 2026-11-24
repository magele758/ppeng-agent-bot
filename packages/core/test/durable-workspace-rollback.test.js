/**
 * Phase 2 WorkspaceTx physical atomic rollback & cognitive-preservation tests.
 * Covers GitShadowWorkspaceTx, dirty-baseline + CAS conflict protection,
 * isolated APFS clone / Git Worktree scopes, CasFileJournalTx binary+mode fallback,
 * lazy zero-overhead read waves, TDD non-rollback, and [tx_rolled_back] folding.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CasFileJournalTx,
  CompositeWorkspaceTxManager,
  RawAgentRuntime,
  commitIsolatedDelta,
  removeIsolatedDir,
  rollbackSessionToStep,
  tryCreateGitWorktree,
} from '../dist/exports/public.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function shaFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function initGitWorkspace(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const repoRoot = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'durable-test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Durable Test']);
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.agent-state/\n', 'utf8');
  mkdirSync(join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repoRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(join(repoRoot, 'app.txt'), 'v1-clean\n', 'utf8');
  writeFileSync(join(repoRoot, 'bin.dat'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]));
  writeFileSync(join(repoRoot, 'run.sh'), '#!/bin/sh\necho ok\n', 'utf8');
  chmodSync(join(repoRoot, 'run.sh'), 0o755);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'initial']);

  return { dir, repoRoot, stateDir };
}

test('GitShadowWorkspaceTx restores write/edit/bash mutations byte-for-byte without touching .git/index or HEAD [AC:durable-workspace-rollback#AC-1]', async (t) => {
  const { repoRoot, stateDir } = initGitWorkspace(t, 'tx-shadow-');
  const tx = new CompositeWorkspaceTxManager(stateDir);

  const indexBefore = shaFile(join(repoRoot, '.git', 'index'));
  const headBefore = git(repoRoot, ['rev-parse', 'HEAD']);

  const handle = await tx.beginScope({
    sessionId: 'sess_1',
    runId: 'run_1',
    workspaceRoot: repoRoot,
    mode: 'in_place',
    backend: 'git_shadow',
  });
  assert.equal(handle.backend, 'git_shadow');
  const sp = await tx.savepoint(handle.scopeId, 'before-bash');

  // Destructive mutations via direct fs + real bash command
  writeFileSync(join(repoRoot, 'app.txt'), 'corrupted-by-agent\n', 'utf8');
  unlinkSync(join(repoRoot, 'bin.dat'));
  chmodSync(join(repoRoot, 'run.sh'), 0o644);
  execFileSync('sh', ['-c', 'mkdir -p nested/sub && echo trash > nested/sub/extra.txt && rm -f run.sh'], { cwd: repoRoot });
  await tx.capturePostState(handle.scopeId);

  const res = await tx.rollbackTo(handle.scopeId, sp);
  assert.equal(res.ok, true);
  assert.equal(res.conflicts.length, 0);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v1-clean\n');
  assert.deepEqual(readFileSync(join(repoRoot, 'bin.dat')), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]));
  assert.equal(readFileSync(join(repoRoot, 'run.sh'), 'utf8'), '#!/bin/sh\necho ok\n');
  assert.equal(lstatSync(join(repoRoot, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(existsSync(join(repoRoot, 'nested', 'sub', 'extra.txt')), false);
  assert.equal(existsSync(join(repoRoot, 'nested')), false);

  // Zero .git pollution
  assert.equal(shaFile(join(repoRoot, '.git', 'index')), indexBefore);
  assert.equal(git(repoRoot, ['rev-parse', 'HEAD']), headBefore);
});

test('GitShadowWorkspaceTx preserves user dirty edits and skips externally modified files via CAS conflicts [AC:durable-workspace-rollback#AC-2]', async (t) => {
  const { repoRoot, stateDir } = initGitWorkspace(t, 'tx-dirty-');
  const tx = new CompositeWorkspaceTxManager(stateDir);

  // User has pre-existing unstaged edit, staged edit, and untracked notes file
  writeFileSync(join(repoRoot, 'app.txt'), 'user-dirty-wip\n', 'utf8');
  writeFileSync(join(repoRoot, 'staged.txt'), 'user-staged-content\n', 'utf8');
  git(repoRoot, ['add', 'staged.txt']);
  writeFileSync(join(repoRoot, 'user-notes.md'), 'private uncommitted notes\n', 'utf8');

  const handle = await tx.beginScope({
    sessionId: 'sess_dirty',
    runId: 'run_dirty',
    workspaceRoot: repoRoot,
    mode: 'in_place',
    backend: 'git_shadow',
  });
  const sp = handle.baseline;
  assert.equal(sp.baselineDirty, true);

  // Agent edits app.txt and staged.txt
  writeFileSync(join(repoRoot, 'app.txt'), 'agent-overwrite-1\n', 'utf8');
  writeFileSync(join(repoRoot, 'staged.txt'), 'agent-overwrite-2\n', 'utf8');
  await tx.capturePostState(handle.scopeId);

  // Human externally edits staged.txt AFTER agent finished!
  writeFileSync(join(repoRoot, 'staged.txt'), 'human-concurrent-edit\n', 'utf8');

  // Rollback without force must preserve human-concurrent-edit in conflicts[] and restore app.txt to user-dirty-wip
  const safeRes = await tx.rollbackTo(handle.scopeId, sp);
  assert.equal(safeRes.ok, false);
  assert.deepEqual(safeRes.conflicts, [{ path: 'staged.txt', reason: 'modified_externally' }]);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'user-dirty-wip\n');
  assert.equal(readFileSync(join(repoRoot, 'staged.txt'), 'utf8'), 'human-concurrent-edit\n');
  assert.equal(readFileSync(join(repoRoot, 'user-notes.md'), 'utf8'), 'private uncommitted notes\n');

  // Explicit force=true overrides the conflict
  const forceRes = await tx.rollbackTo(handle.scopeId, sp, { force: true });
  assert.equal(forceRes.ok, true);
  assert.equal(readFileSync(join(repoRoot, 'staged.txt'), 'utf8'), 'user-staged-content\n');
});

test('Isolated workspace scope (APFS CoW / Git Worktree) isolates mutations until CAS atomic commit and cleans up on abort [AC:durable-workspace-rollback#AC-3]', async (t) => {
  const { repoRoot, stateDir } = initGitWorkspace(t, 'tx-isolated-');
  const tx = new CompositeWorkspaceTxManager(stateDir);

  // Scope 1: mutate in isolated execRoot and abort -> main workspace untouched, clone removed
  const scope1 = await tx.beginScope({
    sessionId: 'sess_iso_1',
    runId: 'run_iso_1',
    workspaceRoot: repoRoot,
    mode: 'isolated',
  });
  assert.notEqual(scope1.execRoot, repoRoot);
  assert.ok(['apfs_clone', 'git_worktree'].includes(scope1.backend));
  writeFileSync(join(scope1.execRoot, 'app.txt'), 'isolated-experiment\n', 'utf8');
  writeFileSync(join(scope1.execRoot, 'temp.txt'), 'should-vanish\n', 'utf8');
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v1-clean\n');
  assert.equal(existsSync(join(repoRoot, 'temp.txt')), false);

  await tx.abortScope(scope1.scopeId);
  assert.equal(existsSync(scope1.execRoot), false);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v1-clean\n');

  // Scope 2: mutate in isolated execRoot, verify CAS conflict check, then commit atomically
  const scope2 = await tx.beginScope({
    sessionId: 'sess_iso_2',
    runId: 'run_iso_2',
    workspaceRoot: repoRoot,
    mode: 'isolated',
  });
  writeFileSync(join(scope2.execRoot, 'app.txt'), 'v2-verified\n', 'utf8');
  writeFileSync(join(scope2.execRoot, 'added.txt'), 'brand-new\n', 'utf8');
  unlinkSync(join(scope2.execRoot, 'bin.dat'));

  // Concurrent external edit on main blocks non-forced commit
  writeFileSync(join(repoRoot, 'app.txt'), 'external-conflict\n', 'utf8');
  const blocked = await tx.commitScope(scope2.scopeId);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.conflicts, [{ path: 'app.txt', reason: 'modified_externally' }]);

  // Restore main back to baseline -> commit succeeds atomically and cleans up isolated copy
  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n.agent-state/\n', 'utf8');
  mkdirSync(join(repoRoot, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repoRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(join(repoRoot, 'app.txt'), 'v1-clean\n', 'utf8');
  const committed = await tx.commitScope(scope2.scopeId);
  assert.equal(committed.ok, true);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v2-verified\n');
  assert.equal(readFileSync(join(repoRoot, 'added.txt'), 'utf8'), 'brand-new\n');
  assert.equal(existsSync(join(repoRoot, 'bin.dat')), false);
  assert.equal(existsSync(scope2.execRoot), false);

  // Scope 3: explicitly test git_worktree backend (whose .git is a regular pointer file)
  const cas = new CasFileJournalTx(stateDir);
  const wtBaseline = cas.captureManifest('wt_scope', repoRoot);
  const wtDir = join(stateDir, 'wt-explicit');
  const wtOk = await tryCreateGitWorktree(repoRoot, wtDir, cas, wtBaseline);
  assert.equal(wtOk, true);
  writeFileSync(join(wtDir, 'wt-file.txt'), 'from-worktree\n', 'utf8');
  const wtCommit = commitIsolatedDelta({
    cas,
    state: {
      scopeId: 'wt_scope',
      workspaceRoot: repoRoot,
      execRoot: wtDir,
      backend: 'git_worktree',
      baselineManifestId: wtBaseline.id,
    },
  });
  await removeIsolatedDir({
    scopeId: 'wt_scope',
    workspaceRoot: repoRoot,
    execRoot: wtDir,
    backend: 'git_worktree',
    baselineManifestId: wtBaseline.id,
  });
  assert.equal(wtCommit.ok, true);
  assert.equal(readFileSync(join(repoRoot, 'wt-file.txt'), 'utf8'), 'from-worktree\n');
});

test('CasFileJournalTx handles non-Git directories and timeout fallback with exact binary+mode restoration [AC:durable-workspace-rollback#AC-4]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-cas-'));
  const workspaceRoot = join(dir, 'plain-dir');
  const stateDir = join(dir, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  writeFileSync(join(workspaceRoot, 'img.bin'), binary);
  writeFileSync(join(workspaceRoot, 'tool.sh'), '#!/bin/sh\necho hi\n', 'utf8');
  chmodSync(join(workspaceRoot, 'tool.sh'), 0o755);

  const tx = new CompositeWorkspaceTxManager(stateDir);
  const handle = await tx.beginScope({
    sessionId: 'sess_cas',
    runId: 'run_cas',
    workspaceRoot,
    mode: 'in_place',
  });
  assert.equal(handle.backend, 'cas_file');

  writeFileSync(join(workspaceRoot, 'img.bin'), Buffer.from([0x00]));
  chmodSync(join(workspaceRoot, 'tool.sh'), 0o600);
  writeFileSync(join(workspaceRoot, 'extra.txt'), 'new\n', 'utf8');
  await tx.capturePostState(handle.scopeId);

  const res = await tx.rollbackTo(handle.scopeId, handle.baseline);
  assert.equal(res.ok, true);
  assert.deepEqual(readFileSync(join(workspaceRoot, 'img.bin')), binary);
  assert.equal(lstatSync(join(workspaceRoot, 'tool.sh')).mode & 0o777, 0o755);
  assert.equal(existsSync(join(workspaceRoot, 'extra.txt')), false);

  // Verify timeout fallback on a real Git repo when savepointTimeoutMs is impossibly tight (-1)
  const { repoRoot: gitRepo, stateDir: gitState } = initGitWorkspace(t, 'tx-timeout-');
  const tx2 = new CompositeWorkspaceTxManager(gitState);
  const degraded = await tx2.beginScope({
    sessionId: 'sess_to',
    runId: 'run_to',
    workspaceRoot: gitRepo,
    mode: 'in_place',
    backend: 'git_shadow',
    savepointTimeoutMs: -1,
  });
  assert.equal(degraded.backend, 'cas_file');
});

test('Real RawAgentRuntime: lazy read waves take 0 savepoints, TDD failure does not auto-rollback, and explicit rollback folds [tx_rolled_back] across restart [AC:durable-workspace-rollback#AC-5]', async (t) => {
  const { repoRoot, stateDir } = initGitWorkspace(t, 'tx-runtime-');

  let turn = 0;
  const rt1 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'tx-runtime-model',
      async runTurn() {
        turn += 1;
        if (turn === 1) {
          // Pure read wave -> MUST take 0 savepoints!
          return {
            stopReason: 'tool_use',
            assistantParts: [{ type: 'tool_call', toolCallId: 'tc_read', name: 'read_file', input: { path: 'app.txt' } }],
          };
        }
        if (turn === 2) {
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'read done' }] };
        }
        if (turn === 3) {
          // Mutating TDD wave: write_file succeeds, bash fails with exit 1 -> MUST NOT auto-rollback!
          return {
            stopReason: 'tool_use',
            assistantParts: [
              { type: 'tool_call', toolCallId: 'tc_write', name: 'write_file', input: { path: 'app.txt', content: 'v2-tdd-draft\n' } },
              { type: 'tool_call', toolCallId: 'tc_fail', name: 'bash', input: { command: 'exit 1' } },
            ],
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'saw test failure, kept draft' }] };
      },
      async summarizeMessages() {
        return 'summary';
      },
    },
  });
  rt1.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });

  // 1. Read-only wave: verify 0 savepoints created (txScopeId stays undefined)
  const sRead = rt1.createChatSession({ title: 'read-only', message: 'read app.txt', background: false });
  rt1.store.updateSession(sRead.id, { metadata: { ...(sRead.metadata ?? {}), permissionMode: 'bypass' } });
  const t0 = performance.now();
  await rt1.runSession(sRead.id);
  const readElapsedMs = performance.now() - t0;
  const readRun = rt1.store.durableJournal.getLatestRunForSession(sRead.id);
  assert.equal(readRun?.txScopeId, undefined);
  assert.ok(readElapsedMs < 2000, `read wave unexpectedly slow: ${readElapsedMs}ms`);

  // 2. Mutating TDD wave: write_file + failing bash("exit 1") -> draft preserved!
  const sTdd = rt1.createChatSession({ title: 'tdd-red', message: 'edit app.txt and run test', background: false });
  rt1.store.updateSession(sTdd.id, { metadata: { ...(sTdd.metadata ?? {}), permissionMode: 'bypass' } });
  await rt1.runSession(sTdd.id);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v2-tdd-draft\n');
  const tddRun = rt1.store.durableJournal.getLatestRunForSession(sTdd.id);
  assert.ok(tddRun?.txScopeId, 'mutating wave should lazily create txScopeId');

  // Destroy rt1 and boot fresh rt2 to prove rollback works across process restart!
  await rt1.destroy();

  const rt2 = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'tx-runtime-model-2',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'summary';
      },
    },
  });
  t.after(() => rt2.destroy());

  const rb = await rollbackSessionToStep(rt2.store, rt2.workspaceTx, {
    sessionId: sTdd.id,
    reason: 'explicit_test_rollback',
  });
  assert.equal(rb.ok, true);
  assert.equal(readFileSync(join(repoRoot, 'app.txt'), 'utf8'), 'v1-clean\n');
  assert.match(rb.notice ?? '', /\[tx_rolled_back\]/);
  const visible = rt2.store.foldMessages(sTdd.id);
  assert.ok(visible.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('[tx_rolled_back]'))));
  assert.equal(rt2.store.durableJournal.getLatestRunForSession(sTdd.id)?.status, 'rolled_back');
});

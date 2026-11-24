/**
 * Composite WorkspaceTx Manager implementing `WorkspaceTxPort`.
 *
 * Selects the optimal physical backend (`git_shadow`, `apfs_clone`,
 * `git_worktree`, or `cas_file`), enforces `savepointTimeoutMs` fallback,
 * and persists scope/savepoint metadata on disk under `<stateDir>/tx-scopes/`
 * so rollbacks remain executable even after a process restart.
 * Every helper kept at CC <= 5.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createId,
  nowIso,
  type BeginWorkspaceScopeInput,
  type DurableWorkspaceBackend,
  type WorkspaceCommitResult,
  type WorkspaceRollbackResult,
  type WorkspaceSavepoint,
  type WorkspaceScopeHandle,
  type WorkspaceTxBackendKind,
  type WorkspaceTxPort,
} from '@ppeng/agent-loop';
import { CasFileJournalTx } from './cas-file-tx.js';
import { GitShadowWorkspaceTx, isGitWorkspace } from './git-shadow-tx.js';
import {
  buildIsolatedBaselineSavepoint,
  commitIsolatedDelta,
  removeIsolatedDir,
  tryCreateApfsClone,
  tryCreateGitWorktree,
  type IsolatedScopeState,
} from './isolated-tx.js';

interface PersistedScopeRecord {
  scopeId: string;
  sessionId: string;
  runId: string;
  workspaceRoot: string;
  execRoot: string;
  mode: 'in_place' | 'isolated';
  backend: WorkspaceTxBackendKind;
  savepointTimeoutMs: number;
  degradedToCas: boolean;
  baseline: WorkspaceSavepoint;
  lastPostStateRef?: string;
  savepoints: Record<string, WorkspaceSavepoint>;
  createdAt: string;
}

function chooseInPlaceBackend(
  pref: DurableWorkspaceBackend | undefined,
  gitAvailable: boolean
): 'git_shadow' | 'cas_file' {
  if (pref === 'cas_file') return 'cas_file';
  if (gitAvailable) return 'git_shadow';
  return 'cas_file';
}

export class CompositeWorkspaceTxManager implements WorkspaceTxPort {
  private readonly scopesDir: string;
  private readonly clonesDir: string;
  readonly gitShadow: GitShadowWorkspaceTx;
  readonly casFile: CasFileJournalTx;

  constructor(private readonly stateDir: string) {
    this.scopesDir = join(stateDir, 'tx-scopes');
    this.clonesDir = join(stateDir, 'tx-clones');
    mkdirSync(this.scopesDir, { recursive: true });
    mkdirSync(this.clonesDir, { recursive: true });
    this.gitShadow = new GitShadowWorkspaceTx(stateDir);
    this.casFile = new CasFileJournalTx(stateDir);
  }

  private scopePath(scopeId: string): string {
    return join(this.scopesDir, `${scopeId}.json`);
  }

  private saveScope(rec: PersistedScopeRecord): void {
    writeFileSync(this.scopePath(rec.scopeId), JSON.stringify(rec), 'utf8');
  }

  loadScope(scopeId: string): PersistedScopeRecord | undefined {
    const p = this.scopePath(scopeId);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as PersistedScopeRecord;
  }

  private requireScope(scopeId: string): PersistedScopeRecord {
    const rec = this.loadScope(scopeId);
    if (!rec) throw new Error(`WorkspaceTx scope not found: ${scopeId}`);
    return rec;
  }

  async beginScope(input: BeginWorkspaceScopeInput): Promise<WorkspaceScopeHandle> {
    const scopeId = createId('txs');
    const timeoutMs = input.savepointTimeoutMs ?? 300;
    if (input.mode === 'isolated') {
      return this.beginIsolatedScope(scopeId, input, timeoutMs);
    }
    return this.beginInPlaceScope(scopeId, input, timeoutMs);
  }

  private async beginInPlaceScope(
    scopeId: string,
    input: BeginWorkspaceScopeInput,
    timeoutMs: number
  ): Promise<WorkspaceScopeHandle> {
    const gitOk = await isGitWorkspace(input.workspaceRoot);
    const chosen = chooseInPlaceBackend(input.backend, gitOk);
    const { savepoint, degraded } = await this.captureInPlaceSavepoint(scopeId, input.workspaceRoot, chosen, timeoutMs, 'baseline');
    const actualBackend: WorkspaceTxBackendKind = degraded ? 'cas_file' : chosen;
    const rec: PersistedScopeRecord = {
      scopeId,
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceRoot: input.workspaceRoot,
      execRoot: input.workspaceRoot,
      mode: 'in_place',
      backend: actualBackend,
      savepointTimeoutMs: timeoutMs,
      degradedToCas: degraded,
      baseline: savepoint,
      lastPostStateRef: savepoint.ref,
      savepoints: { [savepoint.id]: savepoint },
      createdAt: nowIso(),
    };
    this.saveScope(rec);
    return toScopeHandle(rec);
  }

  private async beginIsolatedScope(
    scopeId: string,
    input: BeginWorkspaceScopeInput,
    timeoutMs: number
  ): Promise<WorkspaceScopeHandle> {
    const baselineManifest = this.casFile.captureManifest(scopeId, input.workspaceRoot);
    const destDir = join(this.clonesDir, scopeId);
    const isolatedBackend = await this.createIsolatedCopy(input, destDir, baselineManifest);
    if (!isolatedBackend) {
      return this.beginInPlaceScope(scopeId, { ...input, mode: 'in_place' }, timeoutMs);
    }
    const baseline = buildIsolatedBaselineSavepoint(scopeId, isolatedBackend, baselineManifest);
    const rec: PersistedScopeRecord = {
      scopeId,
      sessionId: input.sessionId,
      runId: input.runId,
      workspaceRoot: input.workspaceRoot,
      execRoot: destDir,
      mode: 'isolated',
      backend: isolatedBackend,
      savepointTimeoutMs: timeoutMs,
      degradedToCas: false,
      baseline,
      lastPostStateRef: baseline.ref,
      savepoints: { [baseline.id]: baseline },
      createdAt: nowIso(),
    };
    this.saveScope(rec);
    return toScopeHandle(rec);
  }

  private async createIsolatedCopy(
    input: BeginWorkspaceScopeInput,
    destDir: string,
    baselineManifest: ReturnType<CasFileJournalTx['captureManifest']>
  ): Promise<'apfs_clone' | 'git_worktree' | undefined> {
    if (input.backend !== 'git_shadow' && (await tryCreateApfsClone(input.workspaceRoot, destDir))) {
      return 'apfs_clone';
    }
    if ((await isGitWorkspace(input.workspaceRoot)) && (await tryCreateGitWorktree(input.workspaceRoot, destDir, this.casFile, baselineManifest))) {
      return 'git_worktree';
    }
    return undefined;
  }

  private async captureInPlaceSavepoint(
    scopeId: string,
    workspaceRoot: string,
    backend: 'git_shadow' | 'cas_file',
    timeoutMs: number,
    label: string
  ): Promise<{ savepoint: WorkspaceSavepoint; degraded: boolean }> {
    if (backend === 'git_shadow') {
      try {
        const res = await this.gitShadow.createSavepoint(scopeId, workspaceRoot, label);
        if (res.durationMs <= timeoutMs) {
          return { savepoint: res.savepoint, degraded: false };
        }
      } catch {
        /* fall back to CAS file journal */
      }
      return { savepoint: this.casFile.createSavepoint(scopeId, workspaceRoot, label), degraded: true };
    }
    return { savepoint: this.casFile.createSavepoint(scopeId, workspaceRoot, label), degraded: false };
  }

  async savepoint(scopeId: string, label: string): Promise<WorkspaceSavepoint> {
    const rec = this.requireScope(scopeId);
    const useBackend: 'git_shadow' | 'cas_file' =
      rec.backend === 'git_shadow' && !rec.degradedToCas ? 'git_shadow' : 'cas_file';
    const { savepoint, degraded } = await this.captureInPlaceSavepoint(
      scopeId,
      rec.execRoot,
      useBackend,
      rec.savepointTimeoutMs,
      label
    );
    if (degraded) rec.degradedToCas = true;
    rec.savepoints[savepoint.id] = savepoint;
    rec.lastPostStateRef = savepoint.ref;
    this.saveScope(rec);
    return savepoint;
  }

  async capturePostState(scopeId: string): Promise<string | undefined> {
    const rec = this.loadScope(scopeId);
    if (!rec) return undefined;
    if (rec.backend === 'git_shadow' && !rec.degradedToCas) {
      const { treeSha } = await this.gitShadow.captureTreeSha(scopeId, rec.execRoot);
      rec.lastPostStateRef = treeSha;
      this.saveScope(rec);
      return treeSha;
    }
    const manifest = this.casFile.captureManifest(scopeId, rec.execRoot);
    rec.lastPostStateRef = manifest.id;
    this.saveScope(rec);
    return manifest.id;
  }

  getSavepoint(scopeId: string, savepointId: string): WorkspaceSavepoint | undefined {
    const rec = this.loadScope(scopeId);
    if (!rec) return undefined;
    return rec.savepoints[savepointId] ?? (rec.baseline.id === savepointId ? rec.baseline : undefined);
  }

  async rollbackTo(
    scopeId: string,
    target: WorkspaceSavepoint,
    opts?: { force?: boolean; expectedCurrentRef?: string }
  ): Promise<WorkspaceRollbackResult> {
    const rec = this.requireScope(scopeId);
    const expectedRef = opts?.expectedCurrentRef ?? rec.lastPostStateRef;
    if (target.backend === 'git_shadow') {
      const res = await this.gitShadow.rollbackToTree({
        scopeId,
        workspaceRoot: rec.execRoot,
        targetTreeSha: target.ref,
        expectedCurrentTreeSha: expectedRef,
        force: opts?.force,
      });
      await this.capturePostState(scopeId);
      return res;
    }
    const res = this.casFile.rollbackToManifest({
      workspaceRoot: rec.execRoot,
      targetManifestId: target.ref,
      expectedCurrentManifestId: expectedRef,
      force: opts?.force,
    });
    await this.capturePostState(scopeId);
    return res;
  }

  async commitScope(scopeId: string, opts?: { force?: boolean }): Promise<WorkspaceCommitResult> {
    const rec = this.requireScope(scopeId);
    if (rec.mode !== 'isolated' || (rec.backend !== 'apfs_clone' && rec.backend !== 'git_worktree')) {
      return { ok: true, changedFiles: [], conflicts: [] };
    }
    const state: IsolatedScopeState = {
      scopeId: rec.scopeId,
      backend: rec.backend,
      workspaceRoot: rec.workspaceRoot,
      execRoot: rec.execRoot,
      baselineManifestId: rec.baseline.ref,
    };
    const res = commitIsolatedDelta({ cas: this.casFile, state, force: opts?.force });
    if (res.ok) await removeIsolatedDir(state);
    return res;
  }

  async abortScope(scopeId: string): Promise<void> {
    const rec = this.loadScope(scopeId);
    if (!rec) return;
    if (rec.mode === 'isolated' && (rec.backend === 'apfs_clone' || rec.backend === 'git_worktree')) {
      await removeIsolatedDir({
        scopeId: rec.scopeId,
        backend: rec.backend,
        workspaceRoot: rec.workspaceRoot,
        execRoot: rec.execRoot,
        baselineManifestId: rec.baseline.ref,
      });
    }
  }
}

function toScopeHandle(rec: PersistedScopeRecord): WorkspaceScopeHandle {
  return {
    scopeId: rec.scopeId,
    execRoot: rec.execRoot,
    workspaceRoot: rec.workspaceRoot,
    backend: rec.backend,
    mode: rec.mode,
    baseline: rec.baseline,
  };
}

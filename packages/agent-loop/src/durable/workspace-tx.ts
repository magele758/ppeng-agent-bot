/**
 * Portable WorkspaceTx contracts and [tx_rolled_back] cognitive-preservation helpers.
 * Zero Node I/O — safe for `mini` preset. Every helper kept at CC <= 5.
 */

import type { DurableWorkspaceBackend } from './types.js';

export type WorkspaceTxBackendKind = 'git_shadow' | 'apfs_clone' | 'git_worktree' | 'cas_file';

export interface WorkspaceSavepoint {
  id: string;
  scopeId: string;
  backend: WorkspaceTxBackendKind;
  /** Backend-specific snapshot pointer (git tree SHA, manifest id, or clone baseline id). */
  ref: string;
  baselineDirty: boolean;
  label?: string;
  createdAt: string;
}

export interface WorkspaceRollbackConflict {
  path: string;
  reason: 'modified_externally';
}

export interface WorkspaceRollbackResult {
  ok: boolean;
  restoredFiles: string[];
  removedFiles: string[];
  conflicts: WorkspaceRollbackConflict[];
  error?: string;
}

export interface WorkspaceCommitResult {
  ok: boolean;
  changedFiles: string[];
  conflicts: WorkspaceRollbackConflict[];
  error?: string;
}

export interface BeginWorkspaceScopeInput {
  sessionId: string;
  runId: string;
  workspaceRoot: string;
  mode: 'in_place' | 'isolated';
  backend?: DurableWorkspaceBackend;
  savepointTimeoutMs?: number;
}

export interface WorkspaceScopeHandle {
  scopeId: string;
  execRoot: string;
  workspaceRoot: string;
  backend: WorkspaceTxBackendKind;
  mode: 'in_place' | 'isolated';
  baseline: WorkspaceSavepoint;
}

export interface WorkspaceTxPort {
  beginScope(input: BeginWorkspaceScopeInput): Promise<WorkspaceScopeHandle>;
  savepoint(scopeId: string, label: string): Promise<WorkspaceSavepoint>;
  capturePostState?(scopeId: string): Promise<string | undefined>;
  rollbackTo(
    scopeId: string,
    target: WorkspaceSavepoint,
    opts?: { force?: boolean; expectedCurrentRef?: string }
  ): Promise<WorkspaceRollbackResult>;
  commitScope(scopeId: string, opts?: { force?: boolean }): Promise<WorkspaceCommitResult>;
  abortScope(scopeId: string): Promise<void>;
  getSavepoint?(scopeId: string, savepointId: string): WorkspaceSavepoint | undefined;
}

export interface TxRolledBackNoticeInput {
  checkpointLabel: string;
  trigger: string;
  restoredFiles: readonly string[];
  removedFiles: readonly string[];
  conflicts: readonly WorkspaceRollbackConflict[];
  compensatedExternal?: readonly string[];
  irreversibleKept?: readonly string[];
  failureSummary?: string;
}

function summarizeFileList(files: readonly string[], verb: string): string {
  if (files.length === 0) return `0 files ${verb}`;
  const preview = files.slice(0, 8).join(', ');
  const suffix = files.length > 8 ? ` (+${files.length - 8} more)` : '';
  return `${files.length} file(s) ${verb} (${preview}${suffix})`;
}

/**
 * Formats a structured [tx_rolled_back] notice so the model retains cognitive
 * evidence of what failed while knowing the workspace was physically reverted.
 */
export function formatTxRolledBackNotice(input: TxRolledBackNoticeInput): string {
  const lines: string[] = [
    '[tx_rolled_back]',
    `Checkpoint: ${input.checkpointLabel}`,
    `Trigger: ${input.trigger}`,
    `Workspace restored: ${summarizeFileList(input.restoredFiles, 'reverted')}, ${summarizeFileList(input.removedFiles, 'removed')}, ${input.conflicts.length} conflict(s)`,
  ];
  if (input.conflicts.length > 0) {
    lines.push(`Skipped external edits: ${input.conflicts.map((c) => c.path).join(', ')}`);
  }
  const external = input.compensatedExternal?.length ? input.compensatedExternal.join(', ') : 'none';
  const kept = input.irreversibleKept?.length ? input.irreversibleKept.join(', ') : 'none';
  lines.push(`External effects compensated: ${external}`);
  lines.push(`Irreversible effects kept: ${kept}`);
  if (input.failureSummary) {
    lines.push(`Failure summary: ${input.failureSummary.slice(0, 600)}`);
  }
  lines.push(
    `Action: The workspace is clean at ${input.checkpointLabel}. Do not assume reverted edits still exist; revise your plan and try a different approach.`
  );
  return lines.join('\n');
}

export interface RollbackFoldStore {
  foldMessages(sessionId: string): Array<{ seq?: number; role: string; parts: Array<{ type: string; toolCallId?: string }> }>;
  appendMessage(sessionId: string, role: 'system', parts: Array<{ type: 'text'; text: string }>, opts?: { key?: string }): unknown;
  appendReplacement?(
    sessionId: string,
    input: {
      startSeq: number;
      endSeq: number;
      role: 'system';
      parts: Array<{ type: 'text'; text: string }>;
      key?: string;
    }
  ): unknown;
}

function isClosedRange(
  messages: readonly { parts: readonly { type: string; toolCallId?: string }[] }[]
): boolean {
  const open = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool_call' && part.toolCallId) open.add(part.toolCallId);
      if (part.type === 'tool_result' && part.toolCallId) open.delete(part.toolCallId);
    }
  }
  return open.size === 0;
}

/**
 * Tail-only cognitive-preservation folding: replaces messages strictly after
 * `afterSeq` when they form a closed tool-call range (preserving all earlier
 * history for Prompt Cache), otherwise appends the [tx_rolled_back] notice.
 */
export function foldRolledBackTail(
  store: RollbackFoldStore,
  sessionId: string,
  opts: { afterSeq?: number; notice: string; key?: string }
): { folded: boolean; startSeq?: number; endSeq?: number } {
  const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: opts.notice }];
  const key = opts.key ?? 'tx-rolled-back';
  if (typeof opts.afterSeq === 'number' && typeof store.appendReplacement === 'function') {
    const visible = store.foldMessages(sessionId);
    const tail = visible.filter((m) => typeof m.seq === 'number' && m.seq > opts.afterSeq!);
    if (tail.length > 0 && isClosedRange(tail)) {
      const startSeq = tail[0]!.seq!;
      const endSeq = tail[tail.length - 1]!.seq!;
      try {
        store.appendReplacement(sessionId, { startSeq, endSeq, role: 'system', parts, key });
        return { folded: true, startSeq, endSeq };
      } catch {
        /* Fall back to appendMessage if WAL range invariants disallow replacement */
      }
    }
  }
  store.appendMessage(sessionId, 'system', parts, { key });
  return { folded: false };
}

import { stripAutoReviewFlags } from '@ppeng/agent-loop';
import { readApprovalWake } from '../approval/unattended-approval.js';
import { stableJson } from '../cron/notification-decision.js';
import type { ApprovalRecord, SessionRecord, ToolContract } from '../types.js';
import type { SourceLedger } from './sources.js';

export type SourceScopeVerdict = 'allowed' | 'approved' | 'pending' | 'rejected' | 'missing';

interface ApprovalSource {
  listApprovals(): ApprovalRecord[];
}

interface ScopeCall {
  name: string;
  input: unknown;
}

export const SOURCE_SCOPE_APPROVAL_PREFIX = 'source-scope:';

/** Escalation flags (requestSmartModeApproval, authorizedBy …) never change which call was approved. */
function sameCall(approval: ApprovalRecord, name: string, args: unknown): boolean {
  return approval.toolName === name && stableJson(stripAutoReviewFlags(approval.args)) === stableJson(stripAutoReviewFlags(args));
}

/** Newest approval for this exact call created at or after the session's current exposure. */
export function latestScopeApproval(
  store: ApprovalSource,
  ledger: SourceLedger,
  sid: string,
  name: string,
  args: unknown
): ApprovalRecord | undefined {
  const floor = ledger.approvalFloor(sid);
  return store
    .listApprovals()
    .filter((a) => a.sessionId === sid && a.createdAt >= floor && sameCall(a, name, args))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function sourceScopeVerdict(
  store: ApprovalSource,
  ledger: SourceLedger,
  sid: string,
  tool: Pick<ToolContract<any>, 'name' | 'sideEffectLevel'>,
  args: unknown
): SourceScopeVerdict {
  if (ledger.allowed(sid, tool.name, tool.sideEffectLevel, args)) return 'allowed';
  return latestScopeApproval(store, ledger, sid, tool.name, args)?.status ?? 'missing';
}

/** A person is watching this root chat; routines, subagents and unattended wakes are not. */
function attendedRoot(session: SessionRecord): boolean {
  if (session.parentSessionId || session.metadata?.routineParentSessionId) return false;
  return readApprovalWake(session.metadata)?.kind !== 'unattended';
}

/**
 * Attended root chats get a card for each call the source scope refuses, and wait.
 * Routines, subagents and unattended wakes keep the immediate denial.
 */
export function planSourceScopeHold(
  store: ApprovalSource,
  ledger: SourceLedger,
  session: SessionRecord,
  tools: ToolContract<any>[],
  calls: readonly ScopeCall[]
): { wait: boolean; create: ScopeCall[] } {
  if (!attendedRoot(session)) return { wait: false, create: [] };
  let wait = false;
  const create: ScopeCall[] = [];
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) continue;
    const verdict = sourceScopeVerdict(store, ledger, session.id, tool, call.input);
    if (verdict === 'missing') create.push(call);
    wait ||= verdict === 'missing' || verdict === 'pending';
  }
  return { wait, create };
}

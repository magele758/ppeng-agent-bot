import {
  SESSION_TOOL_GRANT_KEY,
  addSessionToolGrant,
  normalizeSessionToolGrants,
  otherPendingCovered,
  type ApprovalRecord,
  type RawAgentRuntime
} from '@ppeng/agent-core';

/** Persist a same-tool, same-isolation grant on the session. No new env flag. */
export function rememberSessionGrant(
  runtime: RawAgentRuntime,
  action: string,
  pending: ApprovalRecord | undefined,
  body: unknown
): void {
  if (action !== 'approve' || !pending || !wantsSessionGrant(body)) return;
  const session = runtime.getSession(pending.sessionId);
  runtime.mergeSessionMetadata(pending.sessionId, {
    [SESSION_TOOL_GRANT_KEY]: addSessionToolGrant(session?.metadata, pending.toolName, pending.args)
  });
  for (const matchId of otherPendingCovered(
    runtime.listApprovals('pending'),
    pending.id,
    pending.sessionId,
    pending.toolName,
    pending.args
  )) {
    runtime.store.updateApproval(matchId, 'approved');
  }
}

export function sessionToolGrantPatch(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'sessionToolGrants')) return undefined;
  return { [SESSION_TOOL_GRANT_KEY]: normalizeSessionToolGrants(body.sessionToolGrants) };
}

function wantsSessionGrant(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return (body as { sessionGrant?: unknown }).sessionGrant === true;
}

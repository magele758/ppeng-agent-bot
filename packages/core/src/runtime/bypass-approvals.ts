import type { RawAgentRuntime } from '../runtime.js';
import type { ApprovalRecord } from '../types.js';
import { resolvePermissionMode } from '../approval/permission-mode.js';
import { resumeApprovalContinuation } from '../cron/routine-runtime.js';

type Host = Pick<RawAgentRuntime, 'store' | 'stateDir' | 'approve' | 'runSession' | 'isSessionRunning' | 'emitTraceEvent' | 'hasUnconfirmedEffects' | 'cancelSession'>;
function toolGate(approval: ApprovalRecord): boolean {
  if (approval.toolName === 'ask_user') return false;
  return Boolean(approval.idempotencyKey) || approval.toolName === 'lcu_app_access';
}
function report(host: Host, sessionId: string, error: unknown): void {
  host.emitTraceEvent(sessionId, {kind:'bypass_approval_error',payload:{error:String(error)}});
}
function resume(host: Host, sessionId: string): void {
  if (host.isSessionRunning(sessionId)) return;
  if (host.store.getSession(sessionId)?.status !== 'idle') return;
  if (host.store.listApprovals({status:'pending'}).some(row=>row.sessionId===sessionId)) return;
  const routineHost = {
    store:host.store,stateDir:host.stateDir,log:{warn:()=>{},info:()=>{}},
    runSession:(id:string)=>host.runSession(id), isSessionRunning:(id:string)=>host.isSessionRunning(id),
    hasUnconfirmedEffects:(id:string,since:string)=>host.hasUnconfirmedEffects(id,since),cancelSession:(id:string)=>host.cancelSession(id)
  };
  if (resumeApprovalContinuation(routineHost,sessionId) !== 'not-routine') return;
  void host.runSession(sessionId).catch(error=>report(host,sessionId,error));
}
const reconciling = new WeakSet<object>();

/** Migrate old pending tool gates through normal approval/resume guards; never touch questions or denials. */
export async function reconcileBypassApprovals(host: Host): Promise<void> {
  if (reconciling.has(host)) return;
  reconciling.add(host);
  try { await releasePending(host); } finally { reconciling.delete(host); }
}
async function releasePending(host: Host): Promise<void> {
  const sessions = new Set<string>();
  for (const approval of host.store.listApprovals({status:'pending'})) {
    if (!toolGate(approval)) continue;
    if (hasDenial(host,approval)) continue;
    const session=host.store.getSession(approval.sessionId);
    if (resolvePermissionMode(session?.metadata,process.env) !== 'bypass') continue;
    try {
      await host.approve(approval.id,'approved');
      sessions.add(approval.sessionId);
      host.emitTraceEvent(approval.sessionId,{kind:'bypass_approval_released',payload:{approvalId:approval.id,policy:'bypass'}});
    } catch(error) { report(host,approval.sessionId,error); }
  }
  for (const sessionId of sessions) resume(host,sessionId);
}

function hasDenial(host: Host, approval: ApprovalRecord): boolean {
  if (!approval.idempotencyKey) return false;
  return host.store.listApprovals({status:'rejected'}).some(row => row.sessionId === approval.sessionId && row.idempotencyKey === approval.idempotencyKey);
}

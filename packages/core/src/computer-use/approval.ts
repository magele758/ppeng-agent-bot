import type { ApprovalRecord } from '../types.js';
import type { LcuApproval } from './lcu-provider.js';
interface ApprovalStore {
  createApproval(input: {sessionId:string;toolName:string;reason:string;args:Record<string,unknown>}): ApprovalRecord;
  getApproval(id:string): ApprovalRecord | undefined;
  updateApproval(id:string,status:'rejected'): ApprovalRecord;
  getDaemonControl<T>(key:string): T | undefined;
  setDaemonControl(key:string,value:unknown): void;
}
/** Who may skip the per-app prompt. Explicit bypass is automatic; remembered grants still require direct user authority. */
export interface LcuGrantPolicy {
  autoAllow(sessionId:string): boolean;
  userAuthority(sessionId:string): boolean;
}
type AppRequest = { app:string; persist:unknown[] };
const grantKey = (sessionId:string) => 'lcu-app-grants:' + sessionId;

/** Only native app requests have a supported empty form. Do not invent answers to other schemas. */
function nativeAppRequest(params:Record<string,unknown>): AppRequest | undefined {
  const schema = params.requestedSchema as {type?:string;properties?:Record<string,unknown>;required?:unknown[]} | undefined;
  const meta = params._meta as {connector_id?:string;codex_approval_kind?:string;persist?:unknown;tool_params?:{app?:string}} | undefined;
  if (params.mode !== 'form' || schema?.type !== 'object' || !schema.properties || Object.keys(schema.properties).length > 0 || (schema.required?.length ?? 0) > 0 || meta?.connector_id !== 'computer-use' || meta.codex_approval_kind !== 'mcp_tool_call' || !meta.tool_params?.app) return undefined;
  return { app: meta.tool_params.app, persist: Array.isArray(meta.persist) ? meta.persist : [] };
}
/** Without a persist scope the runtime treats accept as "once" and asks again on every action. */
function accept(request:AppRequest): LcuApproval {
  return request.persist.includes('session') ? {action:'accept',content:{},_meta:{persist:'session'}} : {action:'accept',content:{}};
}
function remembered(store:ApprovalStore,policy:LcuGrantPolicy,sessionId:string,app:string): boolean {
  if (policy.autoAllow(sessionId)) return true;
  return policy.userAuthority(sessionId) && (store.getDaemonControl<string[]>(grantKey(sessionId)) ?? []).includes(app);
}
function remember(store:ApprovalStore,sessionId:string,app:string): void {
  const apps = store.getDaemonControl<string[]>(grantKey(sessionId)) ?? [];
  if (!apps.includes(app)) store.setDaemonControl(grantKey(sessionId), [...apps, app]);
}
async function waitForDecision(store:ApprovalStore,id:string,signal:AbortSignal): Promise<'approved'|'declined'|'cancelled'> {
  while (!signal.aborted) {
    const status=store.getApproval(id)?.status;
    if(status==='approved') return 'approved';
    if(status!=='pending') return 'declined';
    await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,100);signal.addEventListener('abort',done,{once:true});
      if(signal.aborted)done();
    });
  }
  return 'cancelled';
}
export function lcuGrantPolicy(ledger:{bypassGrant(sid:string):boolean;directUser(sid:string):boolean}): LcuGrantPolicy {
  return { autoAllow: sid => ledger.bypassGrant(sid), userAuthority: sid => ledger.directUser(sid) };
}
const denyAll: LcuGrantPolicy = { autoAllow: () => false, userAuthority: () => false };
export function createLcuApprovalHandler(store: ApprovalStore, policy: LcuGrantPolicy = denyAll) {
  return async (sessionId:string,params:Record<string,unknown>,signal:AbortSignal):Promise<LcuApproval> => {
    const request = nativeAppRequest(params);
    if (signal.aborted || !request) return {action:'cancel'};
    if (remembered(store,policy,sessionId,request.app)) return accept(request);
    const approval = store.createApproval({sessionId,toolName:'lcu_app_access',reason:String(params.message ?? 'LCU application access'),args:{originalRequest:params}});
    try {
      const decision = await waitForDecision(store,approval.id,signal);
      if (decision === 'cancelled') return {action:'cancel'};
      if (decision === 'declined') return {action:'decline'};
      remember(store,sessionId,request.app);
      return accept(request);
    }finally{if(store.getApproval(approval.id)?.status==='pending')store.updateApproval(approval.id,'rejected');}
  };
}

import type { ApprovalRecord } from '../types.js';
import type { LcuApproval } from './lcu-provider.js';
interface ApprovalStore {
  createApproval(input: {sessionId:string;toolName:string;reason:string;args:Record<string,unknown>}): ApprovalRecord;
  getApproval(id:string): ApprovalRecord | undefined;
  updateApproval(id:string,status:'rejected'): ApprovalRecord;
}
/** Only native app requests have a supported empty form. Do not invent answers to other schemas. */
export function createLcuApprovalHandler(store: ApprovalStore) {
  return async (sessionId:string,params:Record<string,unknown>,signal:AbortSignal):Promise<LcuApproval> => {
    const schema = params.requestedSchema as {type?:string;properties?:Record<string,unknown>;required?:unknown[]} | undefined;
    const meta = params._meta as {connector_id?:string;codex_approval_kind?:string;tool_params?:{app?:string}} | undefined;
    if (signal.aborted || params.mode !== 'form' || schema?.type !== 'object' || !schema.properties || Object.keys(schema.properties).length > 0 || (schema.required?.length ?? 0) > 0 || meta?.connector_id !== 'computer-use' || meta.codex_approval_kind !== 'mcp_tool_call' || !meta.tool_params?.app) return {action:'cancel'};
    const approval = store.createApproval({sessionId,toolName:'lcu_app_access',reason:String(params.message ?? 'LCU application access'),args:{originalRequest:params}});
    try {
      while (!signal.aborted) {
        const status=store.getApproval(approval.id)?.status;
        if(status==='approved') return {action:'accept',content:{}};
        if(status!=='pending') return {action:'decline'};
        await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,100);signal.addEventListener('abort',done,{once:true});
          if(signal.aborted)done();
        });
      }
      return {action:'cancel'};
    }finally{if(store.getApproval(approval.id)?.status==='pending')store.updateApproval(approval.id,'rejected');}
  };
}

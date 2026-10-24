import type { MessagePart, RunContext, ToolContract } from '../../types.js';
import { checkToolApprovals, executeToolCalls, filterValidToolCalls, processToolResults, type FileApprovalPolicy, type ToolLoopDeps } from '../../runtime/tool-loop.js';
import { stableJsonHash } from '../../runtime/helpers.js';

export interface GoalToolInvocation {
  deps: ToolLoopDeps;
  context: RunContext;
  /** Current identity/session filtered tool list, not the global registry. */
  tools: ToolContract<any>[];
  filePolicy?: FileApprovalPolicy;
  name: string;
  args: Record<string, unknown>;
  /** Stable across approval retries; unique per goal execution + operation. */
  callId: string;
  allowExternalAiTools?: boolean;
}
export interface GoalToolInvocationResult { ok: boolean; content: string; waitingApproval?: boolean; metadata?: Record<string, unknown> }
const waitMarker = 'goal_dispatch_waiting_approval';
function isWaiting(content: string): boolean {
  try { return JSON.parse(content)?.status === waitMarker; } catch { return false; }
}
export async function invokeGoalTool(input: GoalToolInvocation): Promise<GoalToolInvocationResult> {
  const {deps,context,tools,name,args,callId,filePolicy} = input;
  const sessionId = context.session.id;
  deps.store.assertCurrentWriter?.(sessionId);
  if (!callId.trim()) return {ok:false,content:'A stable goal tool call ID is required'};
  const parts = (deps.store.foldMessages?.(sessionId) ?? []).flatMap(message=>message.parts);
  const previousCall = parts.findLast((part): part is Extract<MessagePart,{type:'tool_call'}> => part.type==='tool_call' && part.toolCallId===callId);
  const previousResult = parts.findLast((part): part is Extract<MessagePart,{type:'tool_result'}> => part.type==='tool_result' && part.toolCallId===callId);
  if (previousCall && (previousCall.name !== name || stableJsonHash(name,previousCall.input) !== stableJsonHash(name,args))) return {ok:false,content:'Goal tool call identity was reused with different arguments'};
  if (previousResult && !isWaiting(previousResult.content)) return {ok:previousResult.ok,content:previousResult.content};
  if (previousCall && !previousResult) return {ok:false,content:'Prior tool outcome is unknown; reconcile before retrying'};
  const call: Extract<MessagePart,{type:'tool_call'}> = {type:'tool_call',name,input:args,toolCallId:callId};
  deps.store.appendMessage(sessionId,'assistant',[call]);
  const settle = (result: GoalToolInvocationResult): GoalToolInvocationResult => {
    deps.store.appendMessage(sessionId,'tool',[{type:'tool_result',toolCallId:callId,name,ok:result.ok,content:result.content}]);
    return result;
  };
  const latest = (): GoalToolInvocationResult | undefined => {
    const last = (deps.store.foldMessages?.(sessionId) ?? []).flatMap(message=>message.parts).findLast((part): part is Extract<MessagePart,{type:'tool_result'}> => part.type==='tool_result' && part.toolCallId===callId);
    return last ? {ok:last.ok,content:last.content} : undefined;
  };
  if (!tools.some(tool=>tool.name===name)) return settle({ok:false,content:`Tool ${name} is unavailable or unauthorized in this session`});
  const allowExternal = input.allowExternalAiTools === true;
  const valid = filterValidToolCalls(deps,[call],allowExternal,sessionId,tools);
  if (!valid.length) return latest() ?? settle({ok:false,content:'Tool is unavailable in this session'});
  const closure = {reported:false,ids:[] as string[]};
  const decision = checkToolApprovals(deps,valid,context,filePolicy,context.session,tools,closure);
  if (decision === 'waiting') return settle({ok:false,content:JSON.stringify({status:waitMarker,tool:name,toolCallId:callId}),waitingApproval:true});
  if (decision === 'skip' || closure.ids.includes(callId)) return latest() ?? settle({ok:false,content:'Tool execution was refused'});
  try {
    const results = await executeToolCalls(deps,valid,context,allowExternal,sessionId,tools);
    if (!results.length) return settle({ok:false,content:'Tool execution was interrupted before dispatch'});
    processToolResults(deps,results,valid,context.session,undefined,sessionId);
    const result = results[0]!;
    return {ok:result.ok,content:result.content,...(result.metadata?{metadata:result.metadata}:{})};
  } catch (error) {
    return settle({ok:false,content:`Tool outcome requires reconciliation: ${error instanceof Error ? error.message : String(error)}`});
  }
}
